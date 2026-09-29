from pathlib import Path

import pytest

from prompts import PROMPTS_DIR, PromptError, load_prompt


def write(directory: Path, name: str, text: str) -> None:
    (directory / f"{name}.md").write_text(text, encoding="utf-8")


def test_loads_front_matter_and_renders(tmp_path: Path) -> None:
    write(tmp_path, "greet", '---\nname: greet\nversion: "2"\n---\nHello {{ who }}, {{who}}!\n')

    prompt = load_prompt("greet", tmp_path)

    assert str(prompt.ref) == "greet@2"
    assert prompt.placeholders == {"who"}
    assert prompt.render(who="Sneha") == "Hello Sneha, Sneha!"


def test_missing_value_is_an_error(tmp_path: Path) -> None:
    write(tmp_path, "greet", "---\nname: greet\nversion: 1\n---\nHello {{ who }}\n")

    with pytest.raises(PromptError, match="missing values"):
        load_prompt("greet", tmp_path).render()


@pytest.mark.parametrize(
    ("text", "error"),
    [
        ("Hello", "front matter block"),
        ("---\nname: other\nversion: 1\n---\nHi", "must be 'bad'"),
        ("---\nname: bad\n---\nHi", "needs a version"),
    ],
)
def test_rejects_malformed_files(tmp_path: Path, text: str, error: str) -> None:
    write(tmp_path, "bad", text)

    with pytest.raises(PromptError, match=error):
        load_prompt("bad", tmp_path)


def test_every_shipped_prompt_loads() -> None:
    names = [path.stem for path in PROMPTS_DIR.glob("*.md")]

    assert "dev_chat" in names
    for name in names:
        assert load_prompt(name).version
