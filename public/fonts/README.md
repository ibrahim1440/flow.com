# Self-hosted fonts

The application serves its fonts from this folder; the browser contacts no third-party font
origin (no fonts.googleapis.com, no fonts.gstatic.com).

| Stylesheet | Loaded by | Families and weights |
|---|---|---|
| `ibm-plex.css` | `src/components/shell/AppShell.tsx` (every Direction 2.1 route) and `src/app/login/page.tsx` (sign-in) | IBM Plex Sans Arabic 400 / 500 / 600 / 700 · IBM Plex Sans 300 / 400 / 500 / 600 / 700 (one variable file per subset, wght 100–700) · IBM Plex Mono 400 / 500 |
| `amiri.css` | `src/app/login/page.tsx` (the sign-in screen's brand line, Figma text style Brand/Moment) | Amiri 700 |

## What was copied, and how to check it

These are the exact files Google Fonts served the application before it was self-hosted, so
glyph shapes, metrics, kerning and line boxes are unchanged:

- Each stylesheet is the Google Fonts CSS for the URL the app used to link
  (`ibm-plex.css`: `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap`
  (the 700 weights were added for the Figma Bold styles — G-20 labels; the stylesheet without them
  is byte-identical to what the app linked from Google before self-hosting)),
  fetched with a current Chrome user agent (WOFF2). It is byte-identical to the stylesheet the
  integrator recorded in `tests/hr/visual/fixtures/google-fonts.har` (integration/d21 @ 88789425).
  Only each `src: url(...)` was rewritten to the local path; `font-family`, `font-style`,
  `font-weight`, `font-display: swap`, `unicode-range` and rule order are Google's, so the
  browser picks the same subset file for the same character as before.
- Each `.woff2` is the fonts.gstatic.com file exactly as Google serves it (same bytes, same name,
  versioned folder). These are Google's own builds of the upstream fonts — subset by
  unicode-range, converted to WOFF2, and for IBM Plex Sans a variable font (wght 100–700) — so
  they are modified versions of IBM's and Boutros' original files, not the originals. This
  project redistributes Google's files as they are and changes nothing in them.
  The 19 files that the recording held were compared byte for byte with the fresh downloads: all identical.
- Verify: `cd erp/public/fonts && sha256sum -c SHA256SUMS`.

Faces are not preloaded and use `font-display: swap`, exactly as Google's stylesheet did.
The files are served with `Cache-Control: public, max-age=31536000, immutable`
(`next.config.ts`): a URL here never changes content — a new upstream version gets a new folder.

## Licences

All four families are under the SIL Open Font License 1.1. The licence text ships next to the
files of each family (`<family>/OFL.txt`); see also `NOTICE`.

The copyright column quotes the name table of the bundled files themselves (name ID 0); the
`OFL.txt` texts are the upstream licence files, whose own header years can differ.

| Family | Copyright (in the bundled files) | Reserved Font Name | Version (in the files) | Licence file | Upstream |
|---|---|---|---|---|---|
| IBM Plex Sans Arabic | "Copyright 2019 IBM Corp. All rights reserved." | "Plex" | 1.101 | `ibm-plex-sans-arabic/OFL.txt` | https://github.com/IBM/plex · https://github.com/google/fonts/tree/main/ofl/ibmplexsansarabic |
| IBM Plex Sans | "Copyright 2019 IBM Corp. All rights reserved." | "Plex" | 3.201 (variable, wght 100–700) | `ibm-plex-sans/OFL.txt` | https://github.com/IBM/plex · https://github.com/google/fonts/tree/main/ofl/ibmplexsans |
| IBM Plex Mono | "Copyright 2017 IBM Corp. All rights reserved." | "Plex" | 2.3 | `ibm-plex-mono/OFL.txt` | https://github.com/IBM/plex · https://github.com/google/fonts/tree/main/ofl/ibmplexmono |
| Amiri | "Copyright 2010-2022 The Amiri Project Authors (https://github.com/aliftype/amiri)." | — | 1.002 | `amiri/OFL.txt` | https://github.com/aliftype/amiri · https://github.com/google/fonts/tree/main/ofl/amiri |

**Open owner decision — Reserved Font Name "Plex".** Google's files are Modified Versions under
OFL 1.1 that keep the "IBM Plex" family name. Condition 3 of the OFL bars a Modified Version from
using a Reserved Font Name without the copyright holder's written permission; Google presumably
holds it, but no written statement was found that it extends to redistributors of Google's files.
Options: obtain IBM's confirmation, or switch to IBM's own WOFF2 releases (different versions, so
the pixel and metric verification would have to be repeated).

## Files

| File | Faces (family · weight · subset) | Bytes | sha256 | Source URL |
|---|---|---|---|---|
| `ibm-plex-mono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2` | IBM Plex Mono · 400 · latin | 14708 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2 |
| `ibm-plex-mono/v20/-F63fjptAgt5VM-kVkqdyU8n1iAq129k.woff2` | IBM Plex Mono · 400 · vietnamese | 5868 | `62632b6375305e70ddcafdd895218e6ae41a184fcd280a69c739460604ca00a9` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iAq129k.woff2 |
| `ibm-plex-mono/v20/-F63fjptAgt5VM-kVkqdyU8n1iEq129k.woff2` | IBM Plex Mono · 400 · latin-ext | 13348 | `6bc0f226a5b7884a8170e3f62c63d7675609d4631bdc5931b5cdab81821f00eb` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iEq129k.woff2 |
| `ibm-plex-mono/v20/-F63fjptAgt5VM-kVkqdyU8n1iIq129k.woff2` | IBM Plex Mono · 400 · cyrillic-ext | 6912 | `f8c22ec1804bd6966b70f43ac7c327025645b4c09597117fca2a5a6c750106fe` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iIq129k.woff2 |
| `ibm-plex-mono/v20/-F63fjptAgt5VM-kVkqdyU8n1isq129k.woff2` | IBM Plex Mono · 400 · cyrillic | 8356 | `7635422bd10ddbbcb0e0caa1154b928298f5c8319b8c00b30978d4395f4783ce` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1isq129k.woff2 |
| `ibm-plex-mono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl1FgtIU.woff2` | IBM Plex Mono · 500 · cyrillic-ext | 6972 | `3febe5c7f22e4b07b4552738673c3dbe8bced2dc5f48b866edf7ccd9552d109a` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl1FgtIU.woff2 |
| `ibm-plex-mono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl5FgtIU.woff2` | IBM Plex Mono · 500 · latin-ext | 13432 | `6bb06407c97584b0867a959e05e8874693bfeb8c317de190811c51598f2d99ea` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl5FgtIU.woff2 |
| `ibm-plex-mono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl9FgtIU.woff2` | IBM Plex Mono · 500 · vietnamese | 6040 | `781633d95de88040fb77141d1e65d928c87c0144691fbc74da5a64d137a7e910` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl9FgtIU.woff2 |
| `ibm-plex-mono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2` | IBM Plex Mono · 500 · latin | 14888 | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2 |
| `ibm-plex-mono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlRFgtIU.woff2` | IBM Plex Mono · 500 · cyrillic | 8460 | `1d89462e86cb8e87e7e9d6f6635605bd7c3081baca6caaecee84916bf7b60edc` | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlRFgtIU.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ys43PWrfQ.woff2` | IBM Plex Sans Arabic · 400 · arabic | 42848 | `6010e7fd0dce5d527583951750728cbe3c895efbd16aa0f809ab8c824878c9d8` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ys43PWrfQ.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ys93PU.woff2` | IBM Plex Sans Arabic · 400 · latin | 19164 | `9ed8dcb02e6c7246de4c120295fafa39a7bb73085f4951a4524a07dc911069f2` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ys93PU.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ysw3PWrfQ.woff2` | IBM Plex Sans Arabic · 400 · cyrillic-ext | 1448 | `1144843a05a0eaef92032c0406ee3f001804f2caddba9522e8a265e0a79d46ea` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ysw3PWrfQ.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ysz3PWrfQ.woff2` | IBM Plex Sans Arabic · 400 · latin-ext | 6656 | `1935fa1a3326fcd48e20abe864bb30ace43fe58bd572f354c24271ea66208e04` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3CZRtWPQCuHme67tEYUIx3Kh0PHR9N6Ysz3PWrfQ.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CRXMR5Kw.woff2` | IBM Plex Sans Arabic · 500 · arabic | 45296 | `90aef64fea9794f232332e907d45810ab268d1a11721340025eba2a2cdb36d5c` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CRXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CUXMQ.woff2` | IBM Plex Sans Arabic · 500 · latin | 20088 | `be6a3b2e37f3ad67aa822a55ce356d28c416331c97530a1ec076c2118240ca2d` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CUXMQ.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CZXMR5Kw.woff2` | IBM Plex Sans Arabic · 500 · cyrillic-ext | 1456 | `93ae908392a01f9af1f73e86e99f1665f899a5b58fe9e56517abd199e47dcd01` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CZXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CaXMR5Kw.woff2` | IBM Plex Sans Arabic · 500 · latin-ext | 6540 | `ae5c1a58c18d253e20691f00e401319f01fc568d24d0e50165f276d1a99035b5` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPO_-CaXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCRXMR5Kw.woff2` | IBM Plex Sans Arabic · 600 · arabic | 45688 | `16734a5adb27b0f363e566cbbeacec480da0dc0baa19c8f0053251c2e2bc0eac` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCRXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCUXMQ.woff2` | IBM Plex Sans Arabic · 600 · latin | 20500 | `63f4757271e403f7baec0862f284ffaa4560ea6096ba9fe8bc6e585ca656e724` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCUXMQ.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCZXMR5Kw.woff2` | IBM Plex Sans Arabic · 600 · cyrillic-ext | 1476 | `95875e4fa8928fa68e01e53e0b2cdb0f6dbec1ac61d9af493bb05d2ed230f350` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCZXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCaXMR5Kw.woff2` | IBM Plex Sans Arabic · 600 · latin-ext | 6680 | `0f7c03bb523b8084a84c4b7d95a5c7b294b7318f88b2e51829d5fe7aaef0d0bb` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YPi-OCaXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCRXMR5Kw.woff2` | IBM Plex Sans Arabic · 700 · arabic | 44280 | `04c730b4292731ccedadd5bd80756124364ae4923895145d9cd7b1f28e443de1` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCRXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCUXMQ.woff2` | IBM Plex Sans Arabic · 700 · latin | 19504 | `ae2d59f91ecf9f7ed279e4a1fc1a9da8170fb0ce5b9152917a8f759033f5777c` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCUXMQ.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCZXMR5Kw.woff2` | IBM Plex Sans Arabic · 700 · cyrillic-ext | 1476 | `0c4e072fcf4f07a388448ae321d51fd3915797371a7378270e5630c6d023ea6b` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCZXMR5Kw.woff2 |
| `ibm-plex-sans-arabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCaXMR5Kw.woff2` | IBM Plex Sans Arabic · 700 · latin-ext | 6564 | `ab0b9584271f492336d9eadcef96f99b0da07e8e7046220aea5084f1644a9c9d` | https://fonts.gstatic.com/s/ibmplexsansarabic/v15/Qw3NZRtWPQCuHme67tEYUIx3Kh0PHR9N6YOG-eCaXMR5Kw.woff2 |
| `ibm-plex-sans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxQKYbABA.woff2` | IBM Plex Sans · 300 · latin-ext<br>IBM Plex Sans · 400 · latin-ext<br>IBM Plex Sans · 500 · latin-ext<br>IBM Plex Sans · 600 · latin-ext<br>IBM Plex Sans · 700 · latin-ext | 30964 | `d160e20920ae4d6556518d352d3af27a74e9b0de3d8fe17b1c1044fc75aa2f81` | https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxQKYbABA.woff2 |
| `ibm-plex-sans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxRKYbABA.woff2` | IBM Plex Sans · 300 · vietnamese<br>IBM Plex Sans · 400 · vietnamese<br>IBM Plex Sans · 500 · vietnamese<br>IBM Plex Sans · 600 · vietnamese<br>IBM Plex Sans · 700 · vietnamese | 13160 | `73e7f7b1c980416ae0c2461268b14c7cfcce0668e683dc43fbb11a82a227b9f2` | https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxRKYbABA.woff2 |
| `ibm-plex-sans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxTKYbABA.woff2` | IBM Plex Sans · 300 · cyrillic-ext<br>IBM Plex Sans · 400 · cyrillic-ext<br>IBM Plex Sans · 500 · cyrillic-ext<br>IBM Plex Sans · 600 · cyrillic-ext<br>IBM Plex Sans · 700 · cyrillic-ext | 23568 | `7d0037a170882a49e65a45c38ef195237bb07b1cc791d078379f0ac0d7ae1935` | https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxTKYbABA.woff2 |
| `ibm-plex-sans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxaKYbABA.woff2` | IBM Plex Sans · 300 · cyrillic<br>IBM Plex Sans · 400 · cyrillic<br>IBM Plex Sans · 500 · cyrillic<br>IBM Plex Sans · 600 · cyrillic<br>IBM Plex Sans · 700 · cyrillic | 29512 | `9409ee21811f0f5272b7e1d828fe8838005b0573481ef906e7e55b63f6610ab0` | https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxaKYbABA.woff2 |
| `ibm-plex-sans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxdKYbABA.woff2` | IBM Plex Sans · 300 · greek<br>IBM Plex Sans · 400 · greek<br>IBM Plex Sans · 500 · greek<br>IBM Plex Sans · 600 · greek<br>IBM Plex Sans · 700 · greek | 19500 | `f598dd0700f155e2facfaa8ecfacace397d4c2c153e9ce37ab7ad310e8505bc2` | https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxdKYbABA.woff2 |
| `ibm-plex-sans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxeKYY.woff2` | IBM Plex Sans · 300 · latin<br>IBM Plex Sans · 400 · latin<br>IBM Plex Sans · 500 · latin<br>IBM Plex Sans · 600 · latin<br>IBM Plex Sans · 700 · latin | 45712 | `e2291e842cf5af167122a22881a740c7f2dda7716f1e8cd76680264f4a859470` | https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxeKYY.woff2 |
| `ibm-plex-sans-arabic/OFL.txt` | licence | 4456 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` | https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsansarabic/OFL.txt |
| `ibm-plex-sans/OFL.txt` | licence | 4456 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` | https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/OFL.txt |
| `ibm-plex-mono/OFL.txt` | licence | 4456 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` | https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt |

## Updating
| `amiri/v30/J7acnpd8CGxBHp2VkaY6zp5yGw.woff2` | Amiri · 700 · arabic | 99968 | `c775d9f8c3a7cf0d0c2bb5246dd699e8c09bf6f8758e1be0b98939331b18bcce` | https://fonts.gstatic.com/s/amiri/v30/J7acnpd8CGxBHp2VkaY6zp5yGw.woff2 |
| `amiri/v30/J7acnpd8CGxBHp2VkaYxzp5yGw.woff2` | Amiri · 700 · latin-ext | 10860 | `caca5182eb8536799ec861cbf33c14ed6f5213f3abcd99fffd61adadbc9c66d0` | https://fonts.gstatic.com/s/amiri/v30/J7acnpd8CGxBHp2VkaYxzp5yGw.woff2 |
| `amiri/v30/J7acnpd8CGxBHp2VkaY_zp4.woff2` | Amiri · 700 · latin | 20300 | `f53eb332acb23ec7e09e2487909c56cf841d649c970084d6a74d82aa9534f737` | https://fonts.gstatic.com/s/amiri/v30/J7acnpd8CGxBHp2VkaY_zp4.woff2 |

To take a newer upstream version: fetch the same stylesheet URLs with a current Chrome user agent,
download every `fonts.gstatic.com` file it names into `<family>/<version>/` under its own name,
rewrite the `src` URLs to `/fonts/<family>/<version>/<file>`, regenerate `SHA256SUMS` and this
table, and run the visual suites (any metric change shows up there).

