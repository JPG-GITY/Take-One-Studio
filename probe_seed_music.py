"""Aísla por qué Seed Audio rechaza la generación de música.

    .venv-mac/bin/python probe_seed_music.py

El error observado es:

    code=55001309: downstream error: code=50302201,
    text=InvalidData:SpeakerList empty requires one ReferenceAudio and one Data

`/api/soundtrack/music` llama a `seed_audio.synthesize(prompt, fmt="mp3")` sin `speaker` y
sin referencia, y `synthesize` OMITE la clave `references` cuando no hay ninguna (no manda
una lista vacía — comprobado en el código). Es decir, la petición es text-only, que es
justo lo que `byteplus-genius/references/audio-generation.md` §4 dice que se puede hacer:
"Text-only — omit `references`. Audio is generated purely from `text_prompt`."

El API ya no lo acepta. Esta sonda no supone cuál es el arreglo: prueba las variantes y
dice cuál pasa, para que la corrección se base en una medición y no en una lectura.

Ninguna variante gasta apenas: son clips de un par de segundos.
"""
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="  %(message)s")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
os.chdir(_HERE)

from dotenv import load_dotenv                              # noqa: E402
load_dotenv(os.path.join(_HERE, ".env"))

import seed_audio                                           # noqa: E402

PROMPT = "Instrumental piano music."


def probe(tag: str, **kw) -> bool:
    """Una variante. Devuelve True si el API la aceptó."""
    try:
        data = seed_audio.synthesize(PROMPT, fmt="mp3", timeout=90, **kw)
        print(f"  PASA    {tag:46} {len(data)} bytes")
        return True
    except Exception as e:                                   # noqa: BLE001 — es una sonda
        print(f"  falla   {tag:46} {str(e)[:120]}")
        return False


def main() -> None:
    if not (os.getenv("SEED_AUDIO_API_KEY") or os.getenv("SEED_TTS_API_KEY")):
        print("  Falta SEED_AUDIO_API_KEY / SEED_TTS_API_KEY en .env")
        return

    print("\n── A · text-only, exactamente lo que hace la música hoy ──")
    probe("sin referencias")

    # Si ésta pasa, el rechazo es SÓLO por la SpeakerList vacía y la música puede seguir
    # siendo prompt-driven: basta con darle un speaker cualquiera, porque el contenido lo
    # decide `text_prompt`.
    print("\n── B · con un speaker (la SpeakerList deja de estar vacía) ──")
    for sp in ("zh_male_M392_conversation_wvae_bigtts",
               "en_male_adam_mars_bigtts",
               "en_female_amanda_mars_bigtts"):
        if probe(f"speaker={sp}", speaker=sp):
            break

    # Si sólo pasa ésta, el API pide de verdad audio de referencia y la música deja de ser
    # text-to-audio: habría que darle una semilla sonora.
    print("\n── C · con un audio de referencia real del proyecto ──")
    root = os.path.expanduser("~/Documents/TakeOne-Project")
    seed_clip = ""
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if f == "dialogue.mp3":
                seed_clip = os.path.join(dirpath, f)
                break
        if seed_clip:
            break
    if seed_clip:
        probe(f"reference={os.path.basename(seed_clip)}", reference_audio_path=seed_clip)
    else:
        print("  (sin dialogue.mp3 a mano — variante omitida)")

    print("\n  La variante que PASE es la forma que debe tomar /api/soundtrack/music.")


if __name__ == "__main__":
    main()
