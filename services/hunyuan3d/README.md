# Hunyuan3D provider (optional, user-supplied)

King3D can use Tencent's [Hunyuan3D](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)
as a second generative mesh provider next to TRELLIS.2. **It is off by default and
King3D never ships or downloads its weights.**

## Licence review (2026-10-12) — read before enabling

Read from the primary source (`LICENSE` of Hunyuan3D-2 and Hunyuan3D-2.1; both are
the "Tencent Hunyuan 3D Community License Agreement"). Not legal advice.

| Clause | What it says | Effect on you |
|---|---|---|
| Header | "does not apply in the **European Union, United Kingdom and South Korea**" | No licence at all in those places. |
| Territory (§1) | Worldwide **excluding EU, UK, South Korea** | All rights are granted for the Territory only. |
| §5(c) | Must not use the Works **or the Output** outside the Territory | Meshes generated while in the EU/UK/KR are unlicensed too. |
| §3 | Distribution only inside the Territory; downstream terms must repeat the use restrictions | A public, worldwide GitHub repo cannot redistribute the weights. |
| §4 | Licensee with > 1 million monthly active users needs a separate licence | Irrelevant for a personal tool; relevant if King3D grows. |
| Acceptable Use Policy | Incorporated by reference | Must be passed on to users. |

### Consequences for King3D
- **If you are in the EU, UK or South Korea you may not use Hunyuan3D at all.**
  Check where *you* are, not where the server is.
- The adapter in this repo is King3D's own code and contains no Tencent material.
  The user installs Hunyuan3D themselves, accepts Tencent's licence themselves, and
  is responsible for staying inside the Territory.
- The adapter is therefore disabled unless `KING3D_GEN_HUNYUAN3D_URL` is set, and the
  dashboard labels it with the territory restriction.
- Contrast: TRELLIS.2 is MIT (see `services/trellis/README.md`) and is the
  recommended provider for everyone.

## Status
Wired as a provider slot only. No Hunyuan3D inference code is included yet;
implementing `/generate` is gated on the user confirming they are inside the Territory.
