# Recovery copy of the unpushed branch

GitHub push access was not available for this work (the Claude GitHub App is not
installed on `ibrahim1440/flow.com`). As a result, the branch `feature/accounting-ledger-core` is
delivered as a git bundle, together with a manifest and SHA-256 checksums, through the private
conversation channel. It is not uploaded to any public repository.

## What the bundle is, and what it is not

- **Incremental, not standalone.** The bundle holds only the commits after the prerequisite
  `fc64c05c1ef4e607365e0e0c5d7c32482ed2e26e`, which was `origin/main` when the branch was cut.
  It restores **only** into a repository that already contains that commit, such as any clone of
  `ibrahim1440/flow.com` at or after it.
- **Into an empty repository, it cannot be verified.** `git bundle verify` fails there with a
  missing-prerequisite error.
- **Earlier wording was inaccurate.** An earlier delivery note said the bundle was restored
  "into an empty repository". That overstated what was checked. The check started from an empty
  repository, but the prerequisite commit was fetched into it first.
- **Committed history only.** The bundle has no working tree, no untracked files, and no `.env`
  file other than `.env.example`. Before each bundle is built, the script refuses to proceed if
  any committed `.env` file is in the range. A pattern scan of every added line in the range is
  run for credentials.

## Restoring

```
git clone https://github.com/ibrahim1440/flow.com && cd flow.com
git cat-file -e fc64c05c1ef4e607365e0e0c5d7c32482ed2e26e && echo "prerequisite present"
sha256sum -c SHA256SUMS-<sha>.txt           # in the folder holding the three files
git bundle verify /path/flow.com-accounting-<sha>.bundle
git fetch /path/flow.com-accounting-<sha>.bundle feature/accounting-ledger-core:feature/accounting-ledger-core
git log --oneline fc64c05..feature/accounting-ledger-core   # must match the manifest's list
git push -u origin feature/accounting-ledger-core           # once push access exists
```

## How each bundle is checked before it is shared

1. The checksums are recomputed.
2. A new, empty repository is created.
3. Only the prerequisite commit is fetched into it, from a local copy of `origin/main`.
4. It is confirmed that the repository does **not** yet contain the branch head.
5. `git bundle verify` is run and the branch is fetched from the bundle.
6. The restored head and the tree hash are compared with the source branch.
7. It is confirmed that no committed `.env` file other than `.env.example` is present.

A standalone bundle, meaning full history including `main`, has **not** been produced. That would
mean distributing the whole history of `main`, which has not been scanned for secrets. Given the
credential incident (`CREDENTIAL_INCIDENT.md`), it will only be produced after a full-history scan,
and only if asked.
