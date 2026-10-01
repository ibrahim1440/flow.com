# SDK transfer through Google Drive — 2026-10-01 (INCOMPLETE; SDK NOT EXECUTED)

- **Source:** user-provided **extracted** SDK contents in Google Drive folder `1nq8bzCNNYE6ZqSvGmKd1JNNZE_A6KbQZ`.
  This is a transfer location only.
- **The original archive is not in the folder.** The user-stated archive `zatca-envoice-sdk-203.zip`,
  with SHA-256 `7929a876eeb601150f5143527ffe7142709927b24dbdc35c3a0fda014c9696d9`, was **not present**.
  - Original archive checksum: **NOT VERIFIED**.
  - Authenticity and current-version status: **not independently confirmed**.
  - The original ZATCA download URL and download time are unconfirmed.
- **Downloaded:** with the read-only Drive connector, at 2026-10-01T12:38:24Z. 35 of 37 files; the
  per-file Drive id, size and local SHA-256 are in `MANIFEST.json` and `MANIFEST.tsv`.
- **Not downloaded:** `Apps/cli-3.0.8-jar-with-dependencies.jar` and
  `Lib/Java/sdk-3.0.8-jar-with-dependencies.jar`, 21,178,861 bytes each. The connector returned "File
  too large for download, over limit of 10 MB". **Without them the SDK cannot run: no SDK command was
  executed.**
- **How the bytes arrived:**
  - 11 files came through files saved by the connector;
  - 24 small files came inline and were decoded by the transferring agent. Their sizes all match Drive,
    and their XML, JSON and PEM structure parses, but byte-exactness of those 24 rests on that decoding.
- **Paths:** no unsafe paths (absolute, `..`, separators, NUL), no duplicates, no symbolic links.
- **Compared with the third-party SDK copy** used for the secondary check (`secondary-031daaf/provenance.txt`):
  - `UBL-Invoice-2.1.xsd` is identical;
  - both rule XSLs differ (`20210819_ZATCA_E-invoice_Validation_Rules.xsl`: `e911003e…` vs
    `3312e193…`; `CEN-EN16931-UBL.xsl`: `50e28351…` vs `378a7a4d…`).
  - This is recorded, not interpreted.
- **Instructions read** (`Readme/readme.rtf`):
  - Java `>=11 and <15`;
  - commands `fatoora -validate -invoice <filename>` and `fatoora -generateHash -invoice <filename>`;
  - validation prints `PASS`, or `NOT PASS` with a list of errors (no exact format given);
  - the Linux install needs `jq`, then "Run the install.sh";
  - the bundled certificate and private key are "dummy and for testing purposes only";
  - no bundled sample invoices exist in this build (no `Data/Samples`).
- **`install.sh` of this build:** it exports `FATOORA_HOME` (the SDK root), `PATH` (+`Apps/`) and
  `SDK_CONFIG` into the current shell and writes `Configuration/config.json`; it writes no profile
  file. `Apps/fatoora` reads `${FATOORA_HOME}/global.json`, which is in `Apps/`. How this behaves will
  be recorded from the real run.
- The SDK files themselves are not committed (third-party software, large binaries).
