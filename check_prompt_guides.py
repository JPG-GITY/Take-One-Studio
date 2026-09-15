"""Check an assembled Seedance prompt against the OFFICIAL BytePlus prompt guides.

The project's rules 9 and 10 say every prompt the app generates must be checked against the
official guide for the model it is going to. This makes that mechanical instead of a
reading. Every rule here quotes the guide clause it comes from, so none of them is
somebody's taste:

  2.5  byteplus-genius/references/seedance-2.5-prompt-optimizer-SKILL.md  (the sd25-pe skill)
       byteplus-genius/references/video-seedance-2.5-prompt-guide.md      (the doc page)
  2.0  byteplus-genius/references/video-seedance-2.0-prompt-guide.md

FALLO = the guide forbids it or requires it by name. AVISO = the guide discourages it but
allows exceptions. The two guides CONTRADICT each other on quality and constraint words —
2.0 calls them "necessary configurations", 2.5's principle 8 forbids them as unrequested
boilerplate — so each mode checks its own and never the other's.

    .venv-mac/bin/python check_prompt_guides.py <prompt.txt> [...]        # 2.5
    .venv-mac/bin/python check_prompt_guides.py --20 <prompt.txt> [...]   # 2.0

The prompt to feed it is the one in the render's sidecar, `Shots/<id>/video_vNNN.meta.json`
under the "prompt" key — NOT the log line, which truncates at 120 characters. A dry-run
assembly (`dry_run: true` on /api/video/create) gives the same text without paying.

Exit code is the number of hard failures, so it can gate a script.
"""
import re
import sys

# ── Plantilla "Generation with Reference Materials" (skill, §Video Generation Templates)
TEMPLATE_BLOCKS = [
    ("[Generation Goal]", "§Templates: primer bloque, declara el evento central"),
    ("[Reference Material Roles]", "principio 3: un rol explícito por material activado"),
    ("[Subjects and Relationships]", "§Templates: sujetos y su relación espacial/identidad"),
    ("[Event Script]", "§Templates: Opening / Primary event / Ending state"),
    ("[Maintain Consistency]", "§Templates: qué debe mantenerse constante"),
]

# ── Principio 7: "Do not write aspect ratio, total duration, resolution, frame rate, or
#    the audio toggle into the Prompt."
P7 = [
    (r"\b\d{3,4}p\b", "resolución"),
    (r"\b4k\b", "resolución"),
    (r"\b(16:9|9:16|4:3|1:1|21:9)\b", "relación de aspecto"),
    (r"\b\d+\s*fps\b", "frame rate"),
    (r"generate a \d+[- ]second", "duración total"),
]
# §Target-Duration Override: "Do not invent ranges such as `0-8 seconds` or `8-18 seconds`"
P7_RANGES = r"\b\d+\s*-\s*\d+\s*seconds\b"

# ── Principio 8: "Do not automatically add unrequested quality or stability boilerplate,
#    watermarks, logos, subtitles, duplicate-subject restrictions, or other generic
#    negative constraints."
P8 = [
    (r"do not generate a watermark", "prohibición de marca de agua (nombrada en el principio 8)"),
    (r"gravity and inertia respected", "boilerplate de estabilidad"),
    (r"hd, rich details", "boilerplate de calidad"),
    (r"layered for depth", "boilerplate de calidad"),
]

# TOLERADO, no fallo. La página oficial de 2.5 (§Negative control) dice que el control
# negativo SÍ está soportado para subtítulos ("no subtitles") y por canal para audio
# (SFX / BGM / diálogo). Y anota que el ejemplo oficial de storyboard lleva un bloque
# [Strictly exclude] de estilo, "so a style exclusion list is legitimate in practice".
# El principio 8 prohíbe boilerplate NO PEDIDO, no un control documentado.
TOLERATED = [
    (r"\bno subtitles\b|subtitles, text overlays", "control negativo de subtítulos — soportado oficialmente"),
    (r"do not include:", "lista de exclusión de estilo — tolerada; mejor como bloque [Strictly exclude]"),
]

# ── §Storyboard Grids: "Read it <left to right, top to bottom>"
READING_ORDER = r"left to right"
# El medio del dibujo: la guía pide tablero limpio; nombrarlo lo invoca (A/B 2026-08-31).
MEDIUM = r"pencil|graphite|hatching|smudg|paper grain|charcoal|painterly"

# ── §Long Videos: "Give each stage only one primary state change and state its ending
#    condition." La plantilla escribe End state en cada etapa.
END_STATE = r"end state"

# ── §3 y checklist final: "The final Prompt must not expose raw Asset IDs" / "The Prompt
#    body contains no unavailable material number or raw Asset ID." Un identificador de
#    nuestro almacén junto al `@Image N` le da al modelo dos tokens con @ por material.
RAW_ASSET_ID = r"@image \d+ \(@|@video \d+ \(@|\(@(?:char|loc|prop|board|prev|env)_"


def check(name: str, text: str) -> int:
    t = text.lower()
    fails, warns = [], []

    ids = sorted(set(re.findall(r"\(@[a-z0-9_]+\)", t)))
    if ids:
        fails.append(f"§3/checklist: IDs internos en el cuerpo del prompt {ids[:3]}"
                     f"{'…' if len(ids) > 3 else ''} — 'must not expose raw Asset IDs'")

    # Repetir la misma condición de cierre en varias etapas no declara un cierre: declara
    # que no ha pasado nada, y contradice a la acción de esas etapas.
    ends = re.findall(r"end state: ([^\n]+)", t)
    dupes = {e for e in ends if ends.count(e) > 1}
    if dupes:
        fails.append(f"§Long Videos: {len(ends)} 'End state' y {len(dupes)} repetido(s) "
                     f"literalmente — una etapa que cierra igual que la anterior no cambia nada")

    for block, why in TEMPLATE_BLOCKS:
        if block.lower() not in t:
            fails.append(f"falta {block} — {why}")
    # §Core Workflow 4.5, literal: "Subtract assigned materials from the complete
    # available-material list. If the remainder is nonempty, add [Unused Materials]". Es
    # condicional — un plano que usa todo lo aprobado de su escena no lleva el bloque — así
    # que su ausencia es un aviso para mirar, no un fallo. Antes era fallo duro y marcaba
    # como rotos los prompts que la propia guía da por buenos.
    if "[unused materials]" not in t:
        warns.append("sin [Unused Materials] — correcto sólo si esta toma usa TODO lo aprobado de su escena (§Core Workflow 4.5)")

    for pat, what in P7:
        for m in set(re.findall(pat, t)):
            fails.append(f"principio 7: {what} dentro del prompt ({m!r})")
    rng = set(re.findall(P7_RANGES, t))
    if rng:
        warns.append(f"principio 7: rangos numéricos {sorted(rng)[:3]} — legítimos sólo si los escribió el usuario")

    for pat, what in P8:
        if re.search(pat, t):
            fails.append(f"principio 8: {what}")
    for pat, what in TOLERATED:
        if re.search(pat, t):
            warns.append(what)

    if "storyboard" in t and not re.search(READING_ORDER, t):
        fails.append("§Storyboard Grids: no declara el orden de lectura")
    # §Space and Blocking: "Do not reproduce arrows, annotation boxes, or explanatory text
    # from the diagram in the output video." Medido: sin esta frase, SHOT_018 volvió con la
    # flecha de push-in grabada sobre la mesa (2026-08-31).
    if "storyboard" in t and not re.search(r"never reproduce (?:its |them )?[^.]*?"
                                           r"in the output video", t):
        fails.append("§Space and Blocking: no excluye las flechas/anotaciones del tablero")
    med = sorted(set(re.findall(MEDIUM, t)))
    if med:
        warns.append(f"nombra el medio del dibujo {med} — la guía pide tablero limpio")

    stages = len(re.findall(r"\bshot\s*\d+\b", t))
    ends = len(re.findall(END_STATE, t))
    if stages and ends < stages:
        warns.append(f"§Long Videos: {stages} etapas y sólo {ends} 'End state'")

    dial = re.findall(r"\{[^}]{2,400}\}", text)
    print(f"\n═══ {name} — {len(text)} chars, {len(dial)} línea(s) de diálogo en llaves ═══")
    for f in fails:
        print(f"  FALLO  {f}")
    for w in warns:
        print(f"  aviso  {w}")
    if not fails:
        print("  sin fallos duros contra la guía")
    return len(fails)


# ── Modo 2.0. Su guía oficial (video-seedance-2.0-prompt-guide.md) pide COSAS DISTINTAS,
# y en un caso las contrarias: §"Image quality" da "HD, rich details, cinematic texture,
# natural colors" como ejemplo y llama a ese bloque "necessary configurations"; §"Constraint
# words" lista "do not generate a watermark" y "do not generate a logo". Lo único en lo que
# las dos guías coinciden es en no fijar duración por etapa.
def check_20(name: str, text: str) -> int:
    t = text.lower()
    fails, warns = [], []
    if not re.search(r"\bshot\s*\d+\s*:", t):
        fails.append("§Shot sequencing: faltan las etiquetas 'Shot 1:' / 'Shot 2:'")
    if re.search(r"\bshot\s*\d+\s+[\d.]+\s*s\b", t):
        fails.append("§Shot sequencing: duración por etapa — 'Do not impose strict limits "
                     "on the duration of each segment'; el timing preciso es 'unstable'")
    if "hd, rich details" not in t:
        warns.append("§Image quality: falta el bloque de calidad que la guía llama 'necessary'")
    if "do not generate a watermark" not in t:
        warns.append("§Constraint words: falta 'do not generate a watermark'")
    if re.search(r"\[(generation goal|event script|reference material roles)\]", t):
        fails.append("bloques con corchetes de 2.5 en un prompt 2.0 — no son su vocabulario")
    print(f"\n═══ {name} [modo 2.0] — {len(text)} chars ═══")
    for f in fails:
        print(f"  FALLO  {f}")
    for w in warns:
        print(f"  aviso  {w}")
    if not fails:
        print("  sin fallos duros contra la guía 2.0")
    return len(fails)


if __name__ == "__main__":
    total = 0
    fn = check_20 if "--20" in sys.argv else check
    for path in [a for a in sys.argv[1:] if not a.startswith("--")]:
        total += fn(path.split("/")[-1], open(path, encoding="utf-8").read())
    print(f"\nTOTAL fallos duros: {total}")
    sys.exit(min(total, 125))
