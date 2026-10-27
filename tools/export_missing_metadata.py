"""#AIR3: integrazione mirata dell'esportazione da Unreal Engine 5.7.

Eseguire dal menu Tools > Execute Python Script dell'Editor aperto sul progetto.
Richiede Python Editor Script Plugin e Editor Scripting Utilities gia' abilitati.
Questo script NON e' stato eseguito in Unreal in questa sessione: e' stato
controllato sintatticamente e confrontato con le API ufficiali UE 5.7.

Legge gli asset esistenti e crea una nuova cartella con timestamp in Saved.
Non modifica o salva mesh, materiali, texture, Blueprint, progetto o scena.
Gli unici set_editor_property configurano AssetExportTask transienti.

Esporta:
* assegnazioni materiale per slot delle mesh originali;
* nomi dei morph nell'ordine dell'array Unreal, senza attribuirli ai target GLB;
* parametri texture/scalari/colori e catena dei materiali parent;
* impostazioni texture, inclusi sRGB e flip_green_channel;
* atlas PNG delle hair cards corrispondenti alle mesh gia' inviate;
* texture mancanti dei materiali occhi/denti/ciglia (non tutte le mappe del viso).

I 841 nomi nell'asset Unreal NON provano una corrispondenza per indice con gli
815 target anonimi del GLB ricevuto. Servono fingerprint dei delta o un export
di controlli primari gia' risolti/baked, per attribuire nomi in modo affidabile.
Questo script non esegue RigLogic e non produce un rig ARKit/visemi completo.

API consultate (UE 5.7):
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/SkeletalMesh?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/MaterialEditingLibrary?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/MaterialInstanceConstant?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/GroomAsset?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/HairGroupsCardsSourceDescription?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/HairGroupCardsTextures?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/Texture2D?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/AssetExportTask?application_version=5.7
https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/TextureExporterPNG?application_version=5.7
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import uuid

import unreal


# Asset paths copied from the uploaded export_manifest.json, not inferred.
MESH_PATHS = [
    "/Game/MetaHumans/AIR3/Face/AI_MetaHumanIdentity_FaceMesh",
    "/Game/MetaHumans/AIR3/Body/f_tal_unw_body",
    "/Game/MetaHumans/AIR3/Clothes/ScothSkirt/ScothSkirtWhitheShirtNewBalance",
    "/Game/MetaHumans/AIR3/FemaleHair/Hair/Hair_S_UpdoBuns_CardsMesh_Group0_LOD0",
    "/Game/MetaHumans/AIR3/FemaleHair/Hair/Eyebrows_M_Shaded_CardsMesh_Group0_LOD0",
    "/Game/Meshes/Props/SM_Entrance_Chair",
    "/Game/Meshes/Props/SM_Entrance_MiddleTable",
    "/Game/Meshes/Props/SM_Keyboard",
    "/Game/Meshes/Props/SM_Laptop",
    "/Game/Monitors/Mod_16x9_moniotr",
]
GROOM_PATHS = [
    "/Game/MetaHumans/AIR3/FemaleHair/Hair/Hair_S_UpdoBuns",
    "/Game/MetaHumans/AIR3/FemaleHair/Hair/Eyebrows_M_Shaded",
    "/Game/MetaHumans/AIR3/FemaleHair/Hair/Eyelashes_L_Curl",
]
# Only missing material categories receive PNG exports. Other textures are
# inventoried with settings, so the already supplied large skin maps are not
# exported again. The card atlas textures below are always explicitly selected.
MISSING_MATERIAL_WORDS = ("eye", "teeth", "lacrimal", "cartilage", "hair", "brow")


def main():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    folder = Path(saved).resolve() / (
        "AIR3_Web_Metadata_" + stamp + "_" + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "missing-textures").mkdir()
    report = {
        "schema": "air3.unreal-extra-metadata.v1",
        "engine_version": unreal.SystemLibrary.get_engine_version(),
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "output_directory": str(folder),
        "source_assets_modified_or_saved": False,
        "meshes": {}, "materials": {}, "textures": {}, "grooms": {},
        "warnings": [], "errors": [],
        "limitations": [
            "Unreal morph-array indices are not GLB morph indices. The supplied GLB has 815 unnamed targets; do not assign 841 source names by position.",
            "Facial blend-shape values may be RigLogic corrective deltas. Primary control baking or a verified deformation fingerprint is still required.",
            "Global material parameter getters resolve inheritance; layer/blend overrides are recorded separately and are not silently treated as global values.",
            "Material graphs, dynamic Blueprint overrides, Groom binding and RigLogic are not evaluated or baked by this script.",
            "Card atlas channel semantics must be decoded using the recorded HairTextureLayout, not guessed from an array index.",
            "PNG files are exporter output. No resizing, gamma correction, channel flips or normal reconstruction are applied here.",
        ],
    }
    export_candidates = {}

    def warning(where, exc):
        report["warnings"].append({"where": where, "message": str(exc)[:1000]})

    def prop(obj, name, default=None):
        try:
            return obj.get_editor_property(name)
        except Exception:
            return default

    def asset_path(obj):
        return obj.get_path_name() if obj else None

    def plain(value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if hasattr(value, "get_path_name"):
            return value.get_path_name()
        if all(hasattr(value, k) for k in ("r", "g", "b", "a")):
            return [float(value.r), float(value.g), float(value.b), float(value.a)]
        if isinstance(value, (list, tuple)):
            return [plain(v) for v in value]
        return str(value)

    def texture_info(texture, reason=None, export=False):
        if texture is None:
            return None
        key = asset_path(texture)
        if key not in report["textures"]:
            settings = {}
            for name in (
                "srgb", "flip_green_channel", "compression_settings", "compression_no_alpha",
                "normalize_normals", "lod_group", "lod_bias", "max_texture_size",
                "mip_gen_settings", "virtual_texture_streaming", "source_color_settings",
                "address_x", "address_y", "filter", "adjust_brightness", "adjust_rgb_curve",
                "adjust_min_alpha", "adjust_max_alpha", "chroma_key_texture",
            ):
                settings[name] = plain(prop(texture, name))
            entry = {"name": texture.get_name(), "class": texture.get_class().get_name(),
                     "settings": settings, "uses": [], "export": None}
            if isinstance(texture, unreal.Texture2D):
                try:
                    entry["dimensions"] = [texture.blueprint_get_size_x(), texture.blueprint_get_size_y()]
                except Exception as exc:
                    warning(key + ":dimensions", exc)
            report["textures"][key] = entry
        if reason and reason not in report["textures"][key]["uses"]:
            report["textures"][key]["uses"].append(reason)
        if export:
            export_candidates[key] = texture
        return key

    def parameter_overrides(material):
        output = {}
        for kind in ("texture", "scalar", "vector"):
            values = prop(material, kind + "_parameter_values", []) or []
            entries = []
            for value in values:
                info = prop(value, "parameter_info")
                parameter_value = prop(value, "parameter_value")
                entry = {"name": plain(prop(info, "name")),
                         "association": plain(prop(info, "association")),
                         "index": plain(prop(info, "index")),
                         "value": plain(parameter_value)}
                entries.append(entry)
                if kind == "texture" and parameter_value:
                    texture_info(parameter_value, "override:" + asset_path(material) + ":" + str(entry["name"]))
            output[kind] = entries
        return output

    def material_info(material, inherited_from=None, allow_png=False):
        if material is None:
            return None
        key = asset_path(material)
        if key in report["materials"]:
            if allow_png:
                for texture_key in report["materials"][key].get("resolved_textures", {}).values():
                    if texture_key:
                        texture = unreal.EditorAssetLibrary.load_asset(texture_key)
                        if texture:
                            texture_info(texture, "missing-material:" + key, export=True)
            return key
        entry = {"name": material.get_name(), "class": material.get_class().get_name(),
                 "parent": asset_path(prop(material, "parent")),
                 "inherited_from": inherited_from,
                 "resolved_textures": {}, "resolved_scalars": {}, "resolved_vectors": {},
                 "instance_overrides": parameter_overrides(material)}
        report["materials"][key] = entry
        library = unreal.MaterialEditingLibrary
        is_instance = isinstance(material, unreal.MaterialInstanceConstant)
        is_base = isinstance(material, unreal.Material)
        for kind in ("texture", "scalar", "vector"):
            try:
                names = list(getattr(library, "get_" + kind + "_parameter_names")(material))
            except Exception as exc:
                warning(key + ":" + kind + "_parameters", exc)
                continue
            if not is_instance and not is_base:
                warning(key, "Material class has no supported read-only parameter getter")
                continue
            getter = getattr(library, ("get_material_instance_" if is_instance else "get_material_default_") + kind + "_parameter_value")
            for name in names:
                try:
                    value = getter(material, name)
                    if kind == "texture":
                        entry["resolved_textures"][str(name)] = texture_info(
                            value, "parameter:" + key + ":" + str(name), export=allow_png)
                    else:
                        entry["resolved_" + kind + "s"][str(name)] = plain(value)
                except Exception as exc:
                    warning(key + ":" + str(name), exc)
        parent = prop(material, "parent")
        if parent:
            material_info(parent, inherited_from=key, allow_png=False)
        elif is_base:
            try:
                entry["base_used_textures"] = [texture_info(t, "base-material:" + key)
                    for t in library.get_used_textures(material)]
            except Exception as exc:
                warning(key + ":base_used_textures", exc)
        return key

    def load(path):
        try:
            obj = unreal.EditorAssetLibrary.load_asset(path)
            if obj is None:
                report["errors"].append({"asset": path, "error": "Asset not found"})
            return obj
        except Exception as exc:
            report["errors"].append({"asset": path, "error": str(exc)[:1000]})
            return None

    for path in MESH_PATHS:
        mesh = load(path)
        if mesh is None:
            continue
        slots = prop(mesh, "materials", None)
        if slots is None:
            slots = prop(mesh, "static_materials", [])
        entry = {"class": mesh.get_class().get_name(), "material_slots": []}
        for index, slot in enumerate(slots or []):
            material = prop(slot, "material_interface")
            allow_png = bool(material and any(word in material.get_name().lower()
                                             for word in MISSING_MATERIAL_WORDS))
            entry["material_slots"].append({
                "slot_index": index, "slot_name": plain(prop(slot, "material_slot_name")),
                "imported_slot_name": plain(prop(slot, "imported_material_slot_name")),
                "material": material_info(material, allow_png=allow_png),
            })
        if isinstance(mesh, unreal.SkeletalMesh):
            morphs = list(prop(mesh, "morph_targets", []) or [])
            entry["morph_names_source_array_order"] = [m.get_name() if m else None for m in morphs]
            entry["morph_count"] = len(morphs)
            entry["glb_index_mapping_verified"] = False
            entry["skeleton"] = asset_path(prop(mesh, "skeleton"))
            entry["post_process_anim_blueprint"] = plain(prop(mesh, "post_process_anim_blueprint"))
        report["meshes"][path] = entry

    source_card_meshes = {p for p in MESH_PATHS if "CardsMesh" in p}
    for path in GROOM_PATHS:
        groom = load(path)
        if groom is None:
            continue
        entry = {"class": groom.get_class().get_name(), "materials": [], "cards": []}
        for slot in prop(groom, "hair_groups_materials", []) or []:
            entry["materials"].append({"slot_name": plain(prop(slot, "slot_name")),
                "material": material_info(prop(slot, "material"), allow_png=True)})
        cards = list(prop(groom, "hair_groups_cards", []) or [])
        matching = []
        for card in cards:
            mesh_path = asset_path(prop(card, "imported_mesh"))
            package = mesh_path.split(".", 1)[0] if mesh_path else None
            matching.append(package in source_card_meshes)
        # If no card matches a supplied mesh (e.g. eyelashes), export only the
        # lowest non-negative LOD per group, not every atlas of every LOD.
        lowest = {}
        if not any(matching):
            for i, card in enumerate(cards):
                group = int(prop(card, "group_index", -1))
                lod = int(prop(card, "lod_index", -1))
                if lod >= 0 and (group not in lowest or lod < lowest[group][0]):
                    lowest[group] = (lod, i)
        fallback_indices = {value[1] for value in lowest.values()}
        for i, card in enumerate(cards):
            atlas = prop(card, "textures")
            selected = matching[i] or i in fallback_indices
            card_entry = {"card_index": i, "group_index": plain(prop(card, "group_index")),
                "lod_index": plain(prop(card, "lod_index")),
                "imported_mesh": asset_path(prop(card, "imported_mesh")),
                "texture_layout": plain(prop(atlas, "layout")),
                "selected_for_png": selected, "textures": []}
            for texture_index, texture in enumerate(prop(atlas, "textures", []) or []):
                card_entry["textures"].append({"atlas_index": texture_index,
                    "texture": texture_info(texture, "groom:" + path + ":card=" + str(i)
                        + ":atlas=" + str(texture_index), export=selected)})
            entry["cards"].append(card_entry)
        if not cards:
            warning(path, "Groom has no exported hair_groups_cards metadata; no atlas was guessed")
        report["grooms"][path] = entry

    for key, texture in sorted(export_candidates.items()):
        if not isinstance(texture, unreal.Texture2D):
            report["textures"][key]["export"] = {"ok": False, "reason": "Not a Texture2D"}
            continue
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", texture.get_name())
        filename = name + "__" + hashlib.sha256(key.encode()).hexdigest()[:10] + ".png"
        target = folder / "missing-textures" / filename
        if target.exists():
            raise RuntimeError("Refusing to overwrite " + str(target))
        task = unreal.AssetExportTask()
        # Only this newly constructed export task is modified, never the texture.
        for field, value in {
            "object": texture, "filename": str(target), "automated": True,
            "prompt": False, "selected": False, "replace_identical": False,
            "write_empty_files": False, "exporter": unreal.TextureExporterPNG(),
        }.items():
            task.set_editor_property(field, value)
        try:
            ok = bool(unreal.Exporter.run_asset_export_task(task))
            ok = ok and target.is_file() and target.stat().st_size > 0
            result = {"ok": ok, "file": "missing-textures/" + filename,
                      "errors": [str(e) for e in (prop(task, "errors", []) or [])]}
            if ok:
                result["bytes"] = target.stat().st_size
                digest = hashlib.sha256()
                with target.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                result["sha256"] = digest.hexdigest()
            report["textures"][key]["export"] = result
        except Exception as exc:
            report["textures"][key]["export"] = {"ok": False, "error": str(exc)[:1000]}
    report["summary"] = {
        "meshes": len(report["meshes"]), "materials": len(report["materials"]),
        "textures_inventoried": len(report["textures"]),
        "png_requested": len(export_candidates),
        "png_successful": sum(bool(t.get("export", {}) and t["export"].get("ok"))
                              for t in report["textures"].values()),
    }
    (folder / "air3-missing-metadata.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    unreal.log("#AIR3 export metadata completed: " + str(folder))
    unreal.log(json.dumps(report["summary"]))
    if report["errors"]:
        unreal.log_warning("Some source assets were unavailable; see air3-missing-metadata.json")
    return str(folder)


if __name__ == "__main__":
    main()
