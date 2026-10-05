# Runner image for the official ZATCA SDK (offline validation only). Base pinned by digest:
# eclipse-temurin:11-jre (Java 11, inside the ">=11 and <15" range stated by the SDK readmes seen so
# far — re-check against the official archive's readme; the harness refuses a mismatch). Adds only
# jq and unzip, which the readme's Linux installation needs. Runs as an unprivileged user.
FROM eclipse-temurin:11-jre@sha256:717e7ce17d8a0eb3ddecef1195a778473972c016097356839114da01e6f145dd
RUN apt-get update && apt-get install -y --no-install-recommends jq unzip && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 sdk
USER 10001
