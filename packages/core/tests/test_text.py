from req_core.text import QuoteLocator, SectionIndex, normalize_document_text, page_for


def test_normalize_document_text():
    raw = "﻿Заголовок\r\nстрока с пробелом   \r\n\r\n\r\n\r\nконец​"
    assert normalize_document_text(raw) == "Заголовок\nстрока с пробелом\n\nконец\n"


def test_locate_ignores_markdown_quotes_dashes_and_yo():
    text = "* **Ф-1.** Держатель «активной» карты — KZT\nзадаёт порог.\n"
    m = QuoteLocator(text).locate('Ф-1. Держатель "активной" карты - KZT задает порог')
    assert m is not None
    assert text[m.start:m.end].startswith("Ф-1")
    assert text[m.start:m.end].endswith("порог")
    assert m.score == 100


def test_locate_table_row_without_pipes():
    text = "| Поле | Значение |\n| :--- | :--- |\n| **REST type** | GET |\n"
    m = QuoteLocator(text).locate("REST type | GET")
    assert m is not None
    assert text[m.start:m.end] == "REST type** | GET"


def test_locate_prefers_occurrence_near_hint():
    text = "порог 100. " + "x" * 200 + " порог 100. конец"
    loc = QuoteLocator(text)
    far = loc.locate("порог 100", hint=len(text) - 5)
    assert far is not None and far.start > 100


def test_locate_fuzzy_and_ellipsis_and_missing():
    text = "Сервис передаёт push на отправку в течение минуты после получения события от процессинга.\n"
    loc = QuoteLocator(text)
    fuzzy = loc.locate("Сервис передаёт пуш на отправку в течение минуты после получения события")
    assert fuzzy is not None and fuzzy.score < 100
    ell = loc.locate("Сервис передаёт push … после получения события")
    assert ell is not None and text[ell.start:ell.end].startswith("Сервис")
    assert loc.locate("Совершенно другой текст, которого нет в документе") is None
    assert loc.locate("") is None


def test_section_path(sample_path):
    text = normalize_document_text(sample_path.read_text(encoding="utf-8"))
    idx = SectionIndex(text)
    off = text.index("Ф-1.")
    assert idx.path(off) == "Часть A. Новый функционал › Требования к изменениям › Функциональные требования"
    assert idx.title_at(text.index("Целое число тенге")) == "Особые правила"
    # заголовки внутри блоков кода не считаются
    assert all("Приложение →" not in h.title for h in idx.headings)


def test_page_for():
    assert page_for(0, [0, 100, 200]) == 1
    assert page_for(150, [0, 100, 200]) == 2
    assert page_for(500, [0, 100, 200]) == 3
    assert page_for(5, None) is None
