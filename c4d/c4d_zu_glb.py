# -*- coding: utf-8 -*-
"""Konvertiert .c4d-Dateien headless nach .glb (neben die Originaldatei).

Aufruf:  c4dpy.exe c4d_zu_glb.py datei1.c4d [datei2.c4d ...]
Octane-Materialien kann glTF nicht lesen. Sie werden vor dem Export durch
Standardmaterialien ersetzt (Farbe, Farbtextur, Rauheit). Die .c4d bleibt unverändert.
"""
import os
import sys
import c4d

OCT_MATERIAL = 1029501
OCT_IMAGE_TEXTURE = 1029508
GLTF_EXPORT = getattr(c4d, "FORMAT_GLTFEXPORT", 1041129)


def sym(name):
    return getattr(c4d, name, None)


def walk_shaders(sh):
    while sh:
        yield sh
        for child in walk_shaders(sh.GetDown()):
            yield child
        sh = sh.GetNext()


def resolve_texture(path, doc):
    if not path:
        return None
    if os.path.isabs(path) and os.path.exists(path):
        return path
    base = doc.GetDocumentPath()
    for cand in (os.path.join(base, path), os.path.join(base, "tex", path),
                 os.path.join(base, "tex", os.path.basename(path))):
        if os.path.exists(cand):
            return cand
    return path


def octane_info(mat, doc):
    """Farbe, Farbtextur und Rauheit aus einem Octane-Material lesen."""
    color, tex, rough = c4d.Vector(0.8), None, 0.5
    s_col, s_link, s_rough, s_file = (sym("OCT_MATERIAL_DIFFUSE_COLOR"), sym("OCT_MATERIAL_DIFFUSE_LINK"),
                                      sym("OCT_MATERIAL_ROUGHNESS_FLOAT"), sym("IMAGETEXTURE_FILE"))
    try:
        if s_col is not None and mat[s_col] is not None:
            color = mat[s_col]
        if s_rough is not None and mat[s_rough] is not None:
            rough = float(mat[s_rough])
    except Exception:
        pass
    if s_file is None:
        return color, tex, rough
    images = [sh for sh in walk_shaders(mat.GetFirstShader()) if sh.GetType() == OCT_IMAGE_TEXTURE]
    link = mat[s_link] if s_link is not None else None
    if link is not None and link.GetType() == OCT_IMAGE_TEXTURE:
        pick = link
    else:
        keys = ("color", "col", "diff", "albedo", "basecolor", "base")
        pick = next((sh for sh in images if any(k in sh.GetName().lower() for k in keys)), None)
        if pick is None and link is not None and images:
            pick = images[0]
    if pick is not None:
        tex = resolve_texture(pick[s_file], doc)
    return color, tex, rough


def replace_octane_materials(doc):
    replaced = {}
    for mat in list(doc.GetMaterials()):
        if mat.GetType() != OCT_MATERIAL:
            continue
        color, tex, rough = octane_info(mat, doc)
        std = c4d.BaseMaterial(c4d.Mmaterial)
        std.SetName(mat.GetName())
        std[c4d.MATERIAL_COLOR_COLOR] = color
        if tex:
            bmp = c4d.BaseShader(c4d.Xbitmap)
            bmp[c4d.BITMAPSHADER_FILENAME] = tex
            std.InsertShader(bmp)
            std[c4d.MATERIAL_COLOR_SHADER] = bmp
        try:  # Rauheit auf die Standard-Glanzschicht
            layer = std.GetReflectionLayerIndex(0)
            if layer is not None:
                std[layer.GetDataID() + c4d.REFLECTION_LAYER_MAIN_VALUE_ROUGHNESS] = rough
        except Exception:
            pass
        doc.InsertMaterial(std)
        replaced[mat] = std

    def visit(op):
        while op:
            for tag in op.GetTags():
                if tag.CheckType(c4d.Ttexture) and tag[c4d.TEXTURETAG_MATERIAL] in replaced:
                    tag[c4d.TEXTURETAG_MATERIAL] = replaced[tag[c4d.TEXTURETAG_MATERIAL]]
            visit(op.GetDown())
            op = op.GetNext()
    visit(doc.GetFirstObject())
    for mat in replaced:
        mat.Remove()
    return len(replaced)


def convert(path):
    doc = c4d.documents.LoadDocument(path, c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS, None)
    if doc is None:
        print("FEHLER: konnte nicht laden: " + path)
        return False
    n = replace_octane_materials(doc)
    out = os.path.splitext(path)[0] + ".glb"
    ok = c4d.documents.SaveDocument(doc, out, c4d.SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST, GLTF_EXPORT)
    c4d.documents.KillDocument(doc)
    if ok and os.path.exists(out):
        mb = os.path.getsize(out) / 1048576.0
        print("OK  %s  (%.1f MB, %d Octane-Material(ien) ersetzt)" % (out, mb, n))
        return True
    print("FEHLER: Export fehlgeschlagen: " + path)
    return False


files = [a for a in sys.argv[1:] if a.lower().endswith(".c4d")]
if not files:
    print("Keine .c4d-Datei angegeben.")
results = [convert(os.path.abspath(f)) for f in files]
print("FERTIG %d/%d" % (sum(results), len(results)))
