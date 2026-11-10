FROM eclipse-temurin:25.0.5_8-jre-noble@sha256:a98128a57de944a72bd31fbc79b898edd5a5864d3652071d5bbd2160ab7d7dce AS java

FROM node:26-trixie-slim

ARG FIREBASE_TOOLS_VERSION=15.35.0

# Temurin 25.0.5+8 contains the vendor's eMudhra CA fix (CVE-2026-114820).
# Copy its bundled trust store, not Debian's vulnerable openjdk package.
# https://adoptium.net/news/2026/10/temurin-october-2026-emudhra/
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"
COPY --from=java /opt/java/openjdk /opt/java/openjdk
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && java -version \
    && keytool -list -v -cacerts -storepass changeit > /tmp/java-cacerts.txt \
    && ! grep -Eiq 'Owner: CN=(emSign ECC Root CA - G3|AAA Certificate Services),' /tmp/java-cacerts.txt \
    && rm /tmp/java-cacerts.txt

RUN npm install --global "firebase-tools@${FIREBASE_TOOLS_VERSION}" \
    && npm cache clean --force \
    && firebase --version

RUN groupadd -r emulator && useradd -r -g emulator -d /home/emulator emulator

WORKDIR /workspace

COPY docker/firebase/entrypoint.sh /entrypoint.sh
COPY --chown=emulator:emulator firebase.json /workspace/firebase.json
COPY --chown=emulator:emulator firebase/ /workspace/firebase/
RUN chmod +x /entrypoint.sh \
    && mkdir -p /workspace/.local /home/emulator/.config /home/emulator/.cache/firebase \
    && chown -R emulator:emulator /workspace /home/emulator

USER emulator

EXPOSE 4000 8080 9000 9099 9199

ENTRYPOINT ["/entrypoint.sh"]
