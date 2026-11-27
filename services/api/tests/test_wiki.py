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
    # ссылка из limits больше не находит заметку — название сменилось
    assert (await client.get(f"/api/knowledge/{limits['id']}")).json()["links"][0]["id"] is None

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
