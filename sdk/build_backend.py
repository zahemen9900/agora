from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Iterator

import tomllib
from setuptools import build_meta as _build_meta


_SDK_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SDK_DIR.parent
_SOURCE_PACKAGE = _REPO_ROOT / "agora"
_README_PATH = _SDK_DIR / "README.md"
_MANIFEST_PATH = _SDK_DIR / "MANIFEST.in"
_LICENSE_PATH = _REPO_ROOT / "LICENSE"


def _load_project_metadata() -> dict[str, object]:
    with (_SDK_DIR / "pyproject.toml").open("rb") as fh:
        payload = tomllib.load(fh)
    return dict(payload["project"])


def _python_literal(value: object) -> str:
    return repr(value)


def _render_setup_py() -> str:
    metadata = _load_project_metadata()
    homepage = dict(metadata.get("urls", {})).get("Homepage", "")
    dependencies = list(metadata.get("dependencies", []))
    requires_python = str(metadata.get("requires-python", ">=3.11"))

    return "\n".join(
        [
            "from pathlib import Path",
            "from setuptools import find_packages, setup",
            "",
            "README = Path(__file__).with_name('README.md').read_text(encoding='utf-8')",
            "",
            "setup(",
            f"    name={_python_literal(str(metadata['name']))},",
            f"    version={_python_literal(str(metadata['version']))},",
            f"    description={_python_literal(str(metadata['description']))},",
            "    long_description=README,",
            "    long_description_content_type='text/markdown',",
            f"    python_requires={_python_literal(requires_python)},",
            f"    install_requires={_python_literal(dependencies)},",
            f"    url={_python_literal(str(homepage))},",
            "    packages=find_packages(include=['agora*']),",
            "    include_package_data=False,",
            ")",
            "",
        ]
    )


@contextlib.contextmanager
def _pushd(path: Path) -> Iterator[None]:
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


@contextlib.contextmanager
def _staged_project() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="agora-sdk-build-") as tmp_dir:
        stage = Path(tmp_dir)
        shutil.copytree(_SOURCE_PACKAGE, stage / "agora")
        shutil.copy2(_README_PATH, stage / "README.md")
        shutil.copy2(_MANIFEST_PATH, stage / "MANIFEST.in")
        shutil.copy2(_LICENSE_PATH, stage / "LICENSE")
        (stage / "setup.py").write_text(_render_setup_py(), encoding="utf-8")
        yield stage


def _run_in_stage(hook_name: str, *args: object, **kwargs: object) -> object:
    hook = getattr(_build_meta, hook_name)
    with _staged_project() as stage, _pushd(stage):
        return hook(*args, **kwargs)


def get_requires_for_build_wheel(
    config_settings: dict[str, object] | None = None,
) -> list[str]:
    return list(_run_in_stage("get_requires_for_build_wheel", config_settings))


def get_requires_for_build_sdist(
    config_settings: dict[str, object] | None = None,
) -> list[str]:
    return list(_run_in_stage("get_requires_for_build_sdist", config_settings))


def build_wheel(
    wheel_directory: str,
    config_settings: dict[str, object] | None = None,
    metadata_directory: str | None = None,
) -> str:
    return str(_run_in_stage("build_wheel", wheel_directory, config_settings, metadata_directory))


def build_sdist(
    sdist_directory: str,
    config_settings: dict[str, object] | None = None,
) -> str:
    return str(_run_in_stage("build_sdist", sdist_directory, config_settings))


def prepare_metadata_for_build_wheel(
    metadata_directory: str,
    config_settings: dict[str, object] | None = None,
) -> str:
    return str(
        _run_in_stage("prepare_metadata_for_build_wheel", metadata_directory, config_settings)
    )


def get_requires_for_build_editable(
    config_settings: dict[str, object] | None = None,
) -> list[str]:
    return list(_run_in_stage("get_requires_for_build_editable", config_settings))


def build_editable(
    wheel_directory: str,
    config_settings: dict[str, object] | None = None,
    metadata_directory: str | None = None,
) -> str:
    return str(_run_in_stage("build_editable", wheel_directory, config_settings, metadata_directory))


def prepare_metadata_for_build_editable(
    metadata_directory: str,
    config_settings: dict[str, object] | None = None,
) -> str:
    return str(
        _run_in_stage("prepare_metadata_for_build_editable", metadata_directory, config_settings)
    )
