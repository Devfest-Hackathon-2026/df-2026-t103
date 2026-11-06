FROM node:22-trixie-slim

ARG FIREBASE_TOOLS_VERSION=15.35.0

# エミュレータのJava要件は下限指定: firebase-tools@15 以降は Java 21+ 必須（21/25/26 など21以上なら動作）。
# Debian trixie 公式で入手できる最新LTSの openjdk-25 を使い、将来の firebase-tools 更新にも対応する。
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-25-jre-headless curl \
    && rm -rf /var/lib/apt/lists/*

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
