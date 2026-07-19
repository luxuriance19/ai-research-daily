#!/usr/bin/env python3
"""Render a provenance-audited formula manifest into PNG assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import matplotlib
from PIL import Image, ImageDraw, ImageFont

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def expected_name(latex: str) -> str:
    digest = hashlib.sha256(latex.encode("utf-8")).hexdigest()[:12]
    return f"formula-{digest}.png"


def render_formula(formula: str, target: Path) -> None:
    """Render MathText, with a readable raster fallback for unsupported LaTeX."""
    fontsize = 26
    figure = plt.figure(figsize=(0.2, 0.2), dpi=180)
    figure.patch.set_alpha(0)
    try:
        figure.text(
            0.01,
            0.5,
            f"${formula.strip()}$",
            fontsize=fontsize,
            color="#183153",
            va="center",
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        figure.savefig(
            target,
            dpi=180,
            bbox_inches="tight",
            pad_inches=0.08,
            transparent=True,
        )
    except Exception:
        plain = re.sub(
            r"\\(?:texttt|textrm|mathrm|mathbf|mathit)\{([^{}]*)\}",
            r"\1",
            formula,
        ).replace("\\", "")
        font = ImageFont.load_default(size=fontsize)
        probe = Image.new("RGBA", (10, 10), (255, 255, 255, 0))
        box = ImageDraw.Draw(probe).textbbox((0, 0), plain, font=font)
        width = min(max(box[2] - box[0] + 36, 120), 1800)
        height = max(box[3] - box[1] + 28, 50)
        fallback = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        ImageDraw.Draw(fallback).text((18, 10), plain, font=font, fill="#183153")
        target.parent.mkdir(parents=True, exist_ok=True)
        fallback.save(target, "PNG")
    finally:
        plt.close(figure)


def render_manifest(manifest_path: Path, output_dir: Path) -> list[Path]:
    manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("mode") != "verified-formula-site-manifest":
        raise ValueError("unexpected formula manifest mode")
    policy = manifest.get("policy", {})
    if (
        policy.get("research_formula_requires_exact_primary_excerpt") is not True
        or policy.get("inferred_or_reconstructed_formulas_allowed") is not False
        or policy.get("client_side_math_runtime_required") is not False
        or policy.get("wechat_raster_assets") is not True
    ):
        raise ValueError("formula manifest crossed its provenance or raster policy")

    rendered: list[Path] = []
    for formula in manifest.get("formulas", []):
        latex = str(formula.get("latex", "")).strip()
        asset_file = str(formula.get("asset_file", ""))
        if not latex or asset_file != expected_name(latex):
            raise ValueError(
                f"formula asset identity mismatch: {formula.get('id', 'unknown')}"
            )
        if formula.get("scope") == "research-source-exact":
            provenance = formula.get("provenance", {})
            if (
                provenance.get("verification_state") != "source-exact"
                or not provenance.get("source_excerpt_sha256")
            ):
                raise ValueError(
                    "research formula lacks exact-source provenance: "
                    f"{formula.get('id', 'unknown')}"
                )
        target = output_dir / asset_file
        if not target.exists() or target.stat().st_size == 0:
            render_formula(latex, target)
        if target.stat().st_size == 0 or target.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"formula asset is not a valid PNG: {target}")
        rendered.append(target)
    if not rendered:
        raise ValueError("formula manifest produced no assets")
    return rendered


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="data/formula-assets-latest.json")
    parser.add_argument("--output-dir", default="public/formulas")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    paths = render_manifest(Path(args.manifest).resolve(), Path(args.output_dir).resolve())
    print(
        json.dumps(
            {"rendered": len(paths), "assets": [path.name for path in paths]},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
