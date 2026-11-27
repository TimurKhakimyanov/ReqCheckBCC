"""База знаний как вики: папки, ссылки [[…]], правка заметок и граф."""

import asyncio

from app.knowledge import ensure_builtin
from app.wiki import Note, build_graph, criteria_mentions, extract_links, normalize_folder, resolve_links
from req_contracts import Criterion


def test_folder_and_links_parsing():
    assert normalize_folder("/Стандарты//ISO 29148/ ") == "Стандарты/ISO 29148"
    assert normalize_folder("../a/./b\\c") == "a/b/c"
    assert normalize_folder(None) == ""
    text = "См. [[Глоссарий]], [[Банк/Тарифы|тарифы]] и снова [[глоссарий]]; [[ ]] не ссылка"
    assert extract_links(text) == ["Глоссарий", "Банк/Тарифы", "глоссарий"]
    found = criteria_mentions("Требование неоднозначно и не проверяемо; нет приоритетов. set_consistent")
    assert {Criterion.UNAMBIGUOUS, Criterion.VERIFIABLE, Criterion.SET_RANKED, Criterion.SET_CONSISTENT} <= set(found)


def test_graph_has_notes_folders_links_and_criteria():
    notes = [
        Note("a", "Глоссарий", "Банк", "manual", "Тиын — 1/100 тенге. Однозначность терминов."),
        Note("b", "Тарифы", "Банк/Карты", "manual", "Суммы — см. [[глоссарий]], [[Банк/Глоссарий]] и [[Нет такой]]."),
        Note("c", "ISO/IEC/IEEE 29148", "", "manual", "Ссылается на [[Тарифы]]."),
        Note("d", "Обзор", "", "manual", "[[ISO/IEC/IEEE 29148]]"),
    ]
    links = resolve_links(notes)
    assert links["b"] == [("глоссарий", "a"), ("Банк/Глоссарий", "a"), ("Нет такой", None)]
    assert links["d"] == [("ISO/IEC/IEEE 29148", "c")]  # «/» в названии — не путь папки
    g = build_graph(notes)
    ids = {n["id"]: n for n in g["nodes"]}
    assert {"a", "b", "folder:Банк", "folder:Банк/Карты", "criterion:unambiguous"} <= set(ids)
    edges = {(e["source"], e["target"], e["kind"]) for e in g["edges"]}
    assert ("b", "a", "link") in edges
    assert ("folder:Банк/Карты", "folder:Банк", "folder") in edges
    assert ("a", "criterion:unambiguous", "criterion") in edges


async def test_wiki_endpoints(client, services):
    assert await asyncio.to_thread(ensure_builtin, services)
    items = (await client.get("/api/knowledge")).json()
    builtin = next(i for i in items if i["source"] == "builtin")
    assert builtin["folder"] == "Стандарты" and builtin["chars"] > 0

    r = await client.post("/api/knowledge", json={"title": "Глоссарий карт", "folder": "/Банк/ Карты/",
                                                   "text": "# Глоссарий\n\nТиын — 1/100 тенге."})
    assert r.status_code == 201, r.text
    gl = r.json()
    assert gl["folder"] == "Банк/Карты"
    r = await client.post("/api/knowledge", data={"folder": "Банк"},
                          files={"file": ("limits.md", "Лимиты в тенге, см. [[Глоссарий карт]].".encode(), "text/markdown")})
    assert r.status_code == 201, r.text
    limits = r.json()
    assert limits["folder"] == "Банк" and limits["title"] == "limits"

    # заметка целиком: текст, ссылки, обратные ссылки
    detail = (await client.get(f"/api/knowledge/{limits['id']}")).json()
    assert detail["content"].startswith("Лимиты") and detail["links"] == [{"title": "Глоссарий карт", "id": gl["id"]}]
    back = (await client.get(f"/api/knowledge/{gl['id']}")).json()
    assert back["backlinks"] == [{"id": limits["id"], "title": "limits"}]

    # правка: текст, название и папка; переиндексация
    r = await client.patch(f"/api/knowledge/{gl['id']}", json={"text": "Тиын — 1/100 тенге. Порог — однозначно в тенге.",
                                                             "folder": "Банк", "title": "Глоссарий"})
    assert r.status_code == 200, r.text
    assert r.json()["folder"] == "Банк" and r.json()["title"] == "Глоссарий" and r.json()["updated_at"]
    detail = (await client.get(f"/api/knowledge/{gl['id']}")).json()
    assert "unambiguous" in detail["criteria"] and detail["status"] == "ready"
    # ссылка из limits поправлена под новое название и по-прежнему ведёт на заметку
    lim = (await client.get(f"/api/knowledge/{limits['id']}")).json()
    assert lim["content"] == "Лимиты в тенге, см. [[Глоссарий]]." and lim["links"] == [{"title": "Глоссарий", "id": gl["id"]}]
    # без update_links ссылка рвётся
    await client.patch(f"/api/knowledge/{gl['id']}", json={"title": "Словарь", "update_links": False})
    assert (await client.get(f"/api/knowledge/{limits['id']}")).json()["links"][0]["id"] is None
    await client.patch(f"/api/knowledge/{gl['id']}", json={"title": "Глоссарий"})

    # поиск по тексту страниц: все слова, совпадение в названии выше
    hits = (await client.get("/api/knowledge/search", params={"q": "тенге глоссарий"})).json()
    assert [h["id"] for h in hits][:2] == [gl["id"], limits["id"]]
    assert "тенге" in hits[0]["snippet"]
    assert (await client.get("/api/knowledge/search", params={"q": "нет-такого-слова"})).json() == []

    # встроенное — только перенос в папку
    r = await client.patch(f"/api/knowledge/{builtin['id']}", json={"text": "x"})
    assert r.status_code == 409 and r.json()["code"] == "builtin_protected"
    assert (await client.patch(f"/api/knowledge/{builtin['id']}", json={"folder": "ISO"})).json()["folder"] == "ISO"
    await client.patch(f"/api/knowledge/{builtin['id']}", json={"folder": "Стандарты"})

    graph = (await client.get("/api/knowledge/graph")).json()
    kinds = {n["kind"] for n in graph["nodes"]}
    assert kinds == {"note", "folder", "criterion"}
    assert any(e["kind"] == "folder" and e["source"] == gl["id"] for e in graph["edges"])

    assert (await client.get("/api/knowledge/00000000-0000-0000-0000-000000000000")).status_code == 404
    actions = [a["action"] for a in (await client.get("/api/audit")).json()["items"]]
    assert "knowledge_updated" in actions
    for x in (gl, limits):
        assert (await client.delete(f"/api/knowledge/{x['id']}")).status_code == 204


async def test_wiki_folders(client):
    async def folders() -> dict[str, dict]:
        return {f["path"]: f for f in (await client.get("/api/knowledge/folders")).json()}

    note = (await client.post("/api/knowledge", json={"title": "Регламент", "folder": "Процессы/Карты", "text": "Текст"})).json()
    # пустая папка создаётся явно; повтор и пустое имя — ошибки
    r = await client.post("/api/knowledge/folders", json={"path": " Процессы / Черновики "})
    assert r.status_code == 201 and r.json() == {"path": "Процессы/Черновики", "notes": 0, "total": 0, "explicit": True}
    assert (await client.post("/api/knowledge/folders", json={"path": "Процессы/Карты"})).json()["code"] == "folder_exists"
    assert (await client.post("/api/knowledge/folders", json={"path": " / "})).status_code == 400
    f = await folders()
    assert f["Процессы"]["total"] == 1 and f["Процессы/Карты"]["notes"] == 1 and f["Процессы/Черновики"]["explicit"]
    graph = (await client.get("/api/knowledge/graph")).json()
    assert any(n["id"] == "folder:Процессы/Черновики" for n in graph["nodes"])

    # переименование и перенос — вместе с вложенными папками и заметками
    r = await client.patch("/api/knowledge/folders", json={"path": "Процессы", "new_path": "Архив/Процессы-2025"})
    assert r.status_code == 200 and r.json() == {"path": "Архив/Процессы-2025", "moved": 1}
    f = await folders()
    assert "Процессы" not in f and {"Архив/Процессы-2025/Карты", "Архив/Процессы-2025/Черновики"} <= set(f)
    assert (await client.get(f"/api/knowledge/{note['id']}")).json()["folder"] == "Архив/Процессы-2025/Карты"
    bad = await client.patch("/api/knowledge/folders", json={"path": "Архив", "new_path": "Архив/Вложенная"})
    assert bad.status_code == 400 and bad.json()["code"] == "folder_into_itself"
    assert (await client.patch("/api/knowledge/folders", json={"path": "Нет", "new_path": "Да"})).status_code == 404
    clash = await client.patch("/api/knowledge/folders",
                               json={"path": "Архив/Процессы-2025/Черновики", "new_path": "Архив/Процессы-2025/Карты"})
    assert clash.status_code == 409

    # удаление: содержимое переезжает в родительскую папку
    r = await client.delete("/api/knowledge/folders", params={"path": "Архив/Процессы-2025"})
    assert r.status_code == 200 and r.json() == {"path": "Архив", "moved": 1}
    f = await folders()
    assert {"Архив/Карты", "Архив/Черновики"} <= set(f) and "Архив/Процессы-2025" not in f
    assert (await client.get(f"/api/knowledge/{note['id']}")).json()["folder"] == "Архив/Карты"
    assert (await client.delete("/api/knowledge/folders", params={"path": "Нет"})).status_code == 404
    actions = {a["action"] for a in (await client.get("/api/audit")).json()["items"]}
    assert {"knowledge_folder_created", "knowledge_folder_moved", "knowledge_folder_deleted"} <= actions

    await client.delete(f"/api/knowledge/{note['id']}")
    for p in ("Архив/Черновики", "Архив/Карты", "Архив"):
        await client.delete("/api/knowledge/folders", params={"path": p})
    assert not {p for p in await folders() if p.startswith("Архив")}


def test_rename_links_and_search():
    from app.wiki import move_path, plain_text, rename_links, search_notes

    md = "# Глоссарий\n\n| Термин | Значение |\n| :--- | :--- |\n| Тиын | 1/100 тенге |\n\nСм. [[Банк/Тарифы|тарифы]], **ПИН-код**"
    assert plain_text(md) == "Глоссарий Термин Значение Тиын 1/100 тенге См. тарифы, ПИН-код"

    text = "См. [[Глоссарий]], [[Банк/глоссарий|словарь]], [[Глоссарий карт]]"
    assert rename_links(text, "Глоссарий", "Словарь") == "См. [[Словарь]], [[Словарь|словарь]], [[Глоссарий карт]]"
    assert move_path("a/b/c", "a/b", "x") == "x/c" and move_path("a/bc", "a/b", "x") == "a/bc"
    assert move_path("a/b", "a/b", "") == "" and move_path("a/b/c", "a", "") == "b/c"
    notes = [Note("1", "Тарифы", "Банк", "manual", "Комиссия 1%. " * 3), Note("2", "Комиссия", "", "manual", "нет")]
    hits = search_notes(notes, "комиссия")
    assert [h.id for h in hits] == ["2", "1"] and hits[1].snippet.startswith("Комиссия")
