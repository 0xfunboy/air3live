#!/usr/bin/env python3
"""Create bounded browser texture derivatives from the exported #AIR3 PNGs.

Inputs are never modified. Requires Pillow >= 10 and NumPy. Normal-map RGB
channels are data: resize linearly, renormalize, encode losslessly. Their green
channel convention is deliberately preserved because the archive does not
include Unreal's FlipGreenChannel import settings. A separate runtime flag is
needed if the source is confirmed to use DirectX tangent-space normals.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np
import PIL
from PIL import Image, features


COLOR = {
    "1.png": (2048, "outfit_tartan", "core"),
    "BodyBaseColor.png": (2048, "body_albedo", "core"),
    "FaceColor_MAIN.png": (2048, "face_albedo", "core"),
    "FaceColor_MAIN_LOD.png": (2048, "face_albedo_lod", "optional"),
    "FaceColor_CM1.png": (2048, "face_color_expression_1", "optional"),
    "FaceColor_CM2.png": (2048, "face_color_expression_2", "optional"),
    "FaceColor_CM3.png": (2048, "face_color_expression_3", "optional"),
    "T_EntranceBigMonitor.png": (1024, "static_monitor_art", "optional"),
    "T_EntranceKeyboard.png": (1024, "keyboard_albedo", "core"),
    "T_EntranceLaptop.png": (1024, "laptop_albedo", "core"),
    "T_EntranceMiddleTable.png": (1024, "desk_albedo", "core"),
    "T_MONITOR_SCREEN1.png": (1024, "static_monitor_art", "optional"),
    "Unnamed_albedo.png": (2048, "sneaker_albedo", "core"),
}
DATA = {
    "FaceCavity_MAIN.png": (1024, "cavity_rgb_alpha_unused_zero", "optional"),
    "FaceEyeLipstickMask.png": (1024, "packed_makeup_mask", "optional"),
    "FaceFoundationBlusherMask.png": (1024, "packed_makeup_mask", "optional"),
    "FaceRoughness_MAIN.png": (2048, "roughness_in_red", "core_source"),
    "FaceRoughness_MAIN_LOD.png": (2048, "roughness_in_red", "optional"),
    "T_Entrance_Keyboard_AO.png": (1024, "ambient_occlusion", "optional"),
}
NORMAL = {
    "FaceNormal_MAIN.png": (2048, "face_normal", "core"),
    "FaceNormal_MAIN_LOD.png": (2048, "face_normal_lod", "optional"),
    "FaceNormal_WM1.png": (2048, "face_wrinkle_normal_1", "optional"),
    "FaceNormal_WM2.png": (2048, "face_wrinkle_normal_2", "optional"),
    "FaceNormal_WM3.png": (2048, "face_wrinkle_normal_3", "optional"),
    "T_BakedNormal_LOD3.png": (256, "low_lod_normal_3", "optional"),
    "T_BakedNormal_LOD4.png": (256, "low_lod_normal_4", "optional"),
    "T_BakedNormal_LOD5.png": (256, "low_lod_normal_5", "optional"),
}


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def pixel_sha256(im: Image.Image) -> str:
    h = hashlib.sha256(f"{im.mode}:{im.width}:{im.height}:".encode())
    for y in range(0, im.height, 128):
        h.update(im.crop((0, y, im.width, min(y + 128, im.height))).tobytes())
    return h.hexdigest()


def target_size(size: tuple[int, int], maximum: int) -> tuple[int, int]:
    factor = min(1.0, maximum / max(size))
    return tuple(max(1, round(x * factor)) for x in size)


def rgba8_mip_bytes(size: tuple[int, int]) -> int:
    w, h = size
    total = 0
    while True:
        total += w * h * 4
        if w == 1 and h == 1:
            return total
        w, h = max(1, w // 2), max(1, h // 2)


def resize_normal(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Normal-map values are linear, even though the container is PNG.

    Pillow resamples the independent L channels without sRGB decoding. Quantized
    results are transformed to signed tangent vectors and normalized. Alpha, if
    meaningful, is resampled independently and is never used to premultiply
    tangent-vector components.
    """
    channels = im.split()
    if size == im.size:
        # Do not perturb the already-small LOD maps unnecessarily.
        return im.copy()
    values = np.stack([
        np.asarray(c.resize(size, Image.Resampling.LANCZOS), dtype=np.float32)
        for c in channels[:3]
    ], axis=-1)
    values = values * (2.0 / 255.0) - 1.0
    length = np.linalg.norm(values, axis=-1, keepdims=True)
    zero = length[..., 0] < 1e-8
    values /= np.maximum(length, 1e-8)
    values[zero] = (0.0, 0.0, 1.0)
    rgb = np.clip(np.rint((values + 1.0) * 127.5), 0, 255).astype(np.uint8)
    out = Image.fromarray(rgb, "RGB")
    if len(channels) == 4 and channels[3].getextrema() != (255, 255):
        out.putalpha(channels[3].resize(size, Image.Resampling.LANCZOS))
    return out


def resize_data(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Work per channel, rather than RGBA-aware interpolation, because alpha may
    # be a packed channel (or uniformly zero, as it is for FaceCavity_MAIN).
    out = Image.merge(im.mode, tuple(
        channel.resize(size, Image.Resampling.LANCZOS) for channel in im.split()
    ))
    if out.mode == "RGBA" and out.getchannel("A").getextrema() in ((255, 255), (0, 0)):
        # Constant-zero alpha in a data map is not opacity. Remove the unused
        # constant channel so browser image premultiplication cannot erase RGB.
        return out.convert("RGB")
    return out


def inspect_output(path: Path, expected: Image.Image, kind: str) -> dict:
    with Image.open(path) as check:
        check.load()
        if check.size != expected.size:
            raise ValueError(f"Unexpected output size: {path}")
        expected_rgba = np.asarray(expected.convert("RGBA"), dtype=np.uint8)
        actual_rgba = np.asarray(check.convert("RGBA"), dtype=np.uint8)
        if not np.array_equal(expected_rgba[..., 3], actual_rgba[..., 3]):
            raise ValueError(f"Output alpha was not preserved exactly: {path}")
        if kind != "color" and not np.array_equal(expected_rgba, actual_rgba):
            raise ValueError(f"Data map was not saved losslessly: {path}")
        result = {"dimensions_verified": True, "alpha_exact_vs_resized": True}
        if kind == "color":
            visible = expected_rgba[..., 3] > 0
            a = expected_rgba[..., :3].astype(np.float32)
            b = actual_rgba[..., :3].astype(np.float32)
            mse = float(np.mean((a[visible] - b[visible]) ** 2)) if visible.any() else 0
            result["rgb_psnr_db_vs_resized"] = round(10 * math.log10(255 ** 2 / mse), 2) if mse else None
            result["quality_reference"] = "resized source, before WebP encoding; not an assessment of resizing loss"
        else:
            result["lossless_vs_resized"] = True
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Directory containing the 27 exported PNGs")
    parser.add_argument("output", type=Path, help="Asset package root, not the textures subdirectory")
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("Input and output must be separate directories")
    if not features.check("webp"):
        raise RuntimeError("Pillow was built without WebP support")
    known = {**COLOR, **DATA, **NORMAL}
    actual_names = {p.name for p in source.glob("*.png")}
    missing = sorted(set(known) - actual_names)
    unexpected = sorted(actual_names - set(known))
    if missing or unexpected:
        raise ValueError(f"Source inventory changed; review before processing. Missing={missing}, unexpected={unexpected}")
    for sub in ("textures/color", "textures/data", "reports"):
        (output / sub).mkdir(parents=True, exist_ok=True)

    report = {
        "schema": "air3-texture-derivatives-v1",
        "tool_versions": {"python": sys.version.split()[0], "pillow": PIL.__version__, "numpy": np.__version__, "libwebp": features.version("webp")},
        "inputs_modified": False,
        "source_png_count": len(actual_names),
        "normal_y_convention": "source preserved; original Unreal FlipGreenChannel/import setting not included",
        "normal_map_color_space": "linear / Three.js NoColorSpace",
        "color_map_color_space": "sRGB / Three.js SRGBColorSpace",
        "gpu_estimate_assumption": "RGBA8 with full mip chain; WebP/PNG are transfer/storage compression, not GPU block compression",
        "missing_texture_families": ["hair cards atlases", "eyebrow cards atlases", "eyelash opacity atlas", "iris/eye maps", "teeth maps"],
        "material_mapping_status": "proposed by actual texture content and GLB material names; original Unreal material graph/assignments not included",
        "files": [],
        "generated": [],
    }
    by_pixels = {}
    for source_path in sorted(source.glob("*.png")):
        name = source_path.name
        kind = "color" if name in COLOR else "normal" if name in NORMAL else "data"
        maximum, semantic, profile = known[name]
        with Image.open(source_path) as im:
            im.load()
            alpha = im.getchannel("A").getextrema() if "A" in im.getbands() else None
            size = target_size(im.size, maximum)
            pixel_hash = pixel_sha256(im)
            entry = {
                "source": name,
                "source_bytes": source_path.stat().st_size,
                "source_sha256": file_sha256(source_path),
                "source_pixel_sha256": pixel_hash,
                "source_dimensions": list(im.size),
                "source_mode": im.mode,
                "source_bit_depth": 8,
                "source_channel_extrema": [list(v) for v in im.getextrema()],
                "source_alpha_range": list(alpha) if alpha else None,
                "source_rgba8_mip_bytes": rgba8_mip_bytes(im.size),
                "semantic": semantic,
                "profile": profile,
                "color_space": "sRGB" if kind == "color" else "linear",
                "normal_y": "preserved_unverified" if kind == "normal" else None,
                "maximum_dimension": maximum,
            }
            if pixel_hash in by_pixels:
                prior = by_pixels[pixel_hash]
                entry.update({
                    "output": prior["output"],
                    "output_dimensions": prior["output_dimensions"],
                    "output_bytes": prior["output_bytes"],
                    "output_mode": prior["output_mode"],
                    "output_sha256": prior["output_sha256"],
                    "output_rgba8_mip_bytes": prior["output_rgba8_mip_bytes"],
                    "validation": prior["validation"],
                    "duplicate_of": prior["source"],
                    "pixel_identical": True,
                })
                report["files"].append(entry)
                print(json.dumps({"source": name, "duplicate_of": prior["source"]}), flush=True)
                continue
            if kind == "normal":
                optimized = resize_normal(im, size)
                method = "independent linear channel Lanczos, tangent vector renormalization; source green channel preserved" if size != im.size else "unchanged small normal map"
            elif kind == "data":
                optimized = resize_data(im, size)
                method = "independent linear channel Lanczos; no alpha premultiplication"
            else:
                optimized = im.resize(size, Image.Resampling.LANCZOS)
                if alpha == (255, 255):
                    optimized = optimized.convert("RGB")
                method = "Lanczos color resize; alpha-aware interpolation for RGBA"
            suffix = ".webp" if kind == "color" else ".png"
            relative = Path("textures") / ("color" if kind == "color" else "data") / f"{source_path.stem}{suffix}"
            destination = output / relative
            temporary = destination.with_name(destination.name + ".tmp")
            if kind == "color":
                # WebP preserves the resized alpha losslessly. exact=True also
                # retains RGB under transparent texels where supported.
                optimized.save(temporary, "WEBP", quality=94 if "FaceColor" in name else 92, method=6, exact=True)
            else:
                optimized.save(temporary, "PNG", optimize=True, compress_level=9)
            temporary.replace(destination)
            entry.update({
                "output": relative.as_posix(),
                "output_dimensions": list(size),
                "output_mode": optimized.mode,
                "output_bytes": destination.stat().st_size,
                "output_sha256": file_sha256(destination),
                "output_rgba8_mip_bytes": rgba8_mip_bytes(size),
                "resize_method": method,
                "validation": inspect_output(destination, optimized, kind),
            })
            if semantic == "cavity_rgb_alpha_unused_zero":
                entry["channel_note"] = "Source RGB data is valid but source alpha is uniformly 0. The unused constant alpha is removed from the derivative to prevent browser alpha premultiplication discarding RGB. Read R for a proposed cavity/occlusion use only after material review."
            if semantic == "roughness_in_red":
                entry["channel_note"] = "R=roughness, G=B=0. glTF/Three.js roughness expects G; use generated FaceRoughness_ORM.png."
            report["files"].append(entry)
            by_pixels[pixel_hash] = entry
            print(json.dumps({"source": name, "output": entry["output"], "bytes": entry["output_bytes"]}), flush=True)

    rough = next(x for x in report["files"] if x["source"] == "FaceRoughness_MAIN.png")
    with Image.open(output / rough["output"]) as im:
        r = im.getchannel("R")
        orm = Image.merge("RGB", (Image.new("L", im.size, 255), r, Image.new("L", im.size, 0)))
        relative = "textures/data/FaceRoughness_ORM.png"
        destination = output / relative
        temporary = destination.with_name(destination.name + ".tmp")
        orm.save(temporary, "PNG", optimize=True, compress_level=9)
        temporary.replace(destination)
        report["generated"].append({
            "output": relative,
            "source": "FaceRoughness_MAIN.png",
            "operation": "R=255 neutral occlusion; G=source.R roughness; B=0 non-metallic",
            "color_space": "linear",
            "profile": "core",
            "output_dimensions": list(orm.size),
            "output_bytes": destination.stat().st_size,
            "output_sha256": file_sha256(destination),
            "output_rgba8_mip_bytes": rgba8_mip_bytes(orm.size),
            "validation": inspect_output(destination, orm, "data"),
        })
    unique = {x["output"]: x for x in report["files"] + report["generated"]}
    core = {x["output"]: x for x in report["files"] + report["generated"] if x.get("profile") == "core"}
    report["totals"] = {
        "source_files": len(report["files"]),
        "source_bytes": sum(x["source_bytes"] for x in report["files"]),
        "source_rgba8_mip_bytes_if_all_loaded": sum(x["source_rgba8_mip_bytes"] for x in report["files"]),
        "unique_output_files_including_orm": len(unique),
        "output_bytes": sum(x["output_bytes"] for x in unique.values()),
        "output_rgba8_mip_bytes_if_all_loaded": sum(x["output_rgba8_mip_bytes"] for x in unique.values()),
        "core_texture_files": len(core),
        "core_bytes": sum(x["output_bytes"] for x in core.values()),
        "core_rgba8_mip_bytes_if_all_loaded": sum(x["output_rgba8_mip_bytes"] for x in core.values()),
    }
    report["core_texture_paths"] = sorted(core)
    for entry in unique.values():
        path = output / entry["output"]
        if path.stat().st_size != entry["output_bytes"] or file_sha256(path) != entry["output_sha256"]:
            raise ValueError(f"Final output byte/hash verification failed: {path}")
        with Image.open(path) as checked:
            checked.load()
    report["final_output_validation"] = {
        "all_unique_files_decode": True,
        "all_output_sizes_match": True,
        "all_output_sha256_match": True,
        "unique_files": len(unique),
    }
    report["runtime_notes"] = [
        "Load only the textures required by visible materials, not this entire folder.",
        "GLB files contain no images and no baseColor/normal texture bindings. Names are not proof of exact UV/material assignments.",
        "FaceColor_MAIN is already 2048px. It has not been upscaled. Original high-frequency normal detail is reduced for browser use.",
        "Optional CM/WM/LOD/makeup maps do not reproduce Unreal's animated material graph automatically.",
        "For externally loaded glTF textures set flipY=false and choose the colorSpace from each entry.",
        "WebP reduces download size. GPU residency is mainly controlled here by resolution and by loading fewer maps.",
        "Normal green channel is unmodified; confirm DirectX/OpenGL import convention against an Unreal reference before setting normalScale.y.",
    ]
    report_path = output / "reports/textures.json"
    report_temporary = report_path.with_name(report_path.name + ".tmp")
    report_temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    report_temporary.replace(report_path)
    print(json.dumps({"report": str(report_path), "totals": report["totals"]}), flush=True)


if __name__ == "__main__":
    main()
