# ManuDesk MCP server on InsForge compute (built remotely on Fly's builder by `insforge compute deploy`).
# Mirrors the Crusoe VM setup (Crusoe-Forge docs/INSFORGE_MIGRATION.md): the core rows plus the live
# tool-window streaming row (Xvfb, xdotool, ImageMagick, Mesa) for the real nextpnr GUI and GTKWave, and the PCB
# rows (KiCad 10, Java 25, Freerouting 2.4.1) for manudesk/pcb. Secrets (MANUDESK_TOKEN, CRUSOE_API_KEY) come from
# compute env, never the image.
#
#   npx @insforge/cli compute deploy . --name manudesk --port 8765 --cpu performance-4x --memory 8192
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON=3.13 \
    UV_PYTHON_INSTALL_DIR=/opt/python

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Pinned OSS CAD Suite build: nightlies change behaviour, and this one is what the Crusoe VM ran.
RUN mkdir -p /opt/fpga \
 && curl -fsSL https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2026-10-17/oss-cad-suite-linux-x64-20261017.tgz \
    | tar -xz -C /opt/fpga \
 && /opt/fpga/oss-cad-suite/bin/yosys -V \
 && /opt/fpga/oss-cad-suite/bin/nextpnr-ecp5 --version \
 && test -x /opt/fpga/oss-cad-suite/bin/gtkwave

# Live tool windows (manudesk/toolstream.py, ported from Crusoe-Forge tc/toolstream_x11.py): each tool gets its
# own Xvfb screen, frames come from ImageMagick `import`, input goes through xdotool. Mesa renders nextpnr's
# OpenGL device view in software; the xcb/xkb libs are what the Qt (nextpnr) and GTK (GTKWave) X11 backends load.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xauth xdotool imagemagick \
      libgl1 libegl1 libglx-mesa0 libgl1-mesa-dri libglu1-mesa \
      libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
      libxcb-render-util0 libxcb-shape0 libxcb-xinerama0 libxcb-xkb1 libxcb-xfixes0 \
      libfontconfig1 libfreetype6 fonts-dejavu-core libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/*

# PCB stage (manudesk/pcb, ported from Crusoe-Forge tc/pcb; versions as proven there): KiCad 10 from the KiCad PPA
# gives kicad-cli (DRC, Gerbers, renders) and the pcbnew module for the system python3; kicad-footprints is only a
# Recommends, so name it. Freerouting 2.4.1 needs Java 25. 3D models (kicad-packages3d, GBs) are left out:
# renders show the bare board.
RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common gpg-agent \
 && add-apt-repository -y ppa:kicad/kicad-10.0-releases \
 && apt-get update \
 && apt-get install -y --no-install-recommends kicad kicad-footprints \
 && rm -rf /var/lib/apt/lists/* \
 && kicad-cli version \
 && /usr/bin/python3 -c "import pcbnew; print('pcbnew', pcbnew.Version())" \
 && test -d /usr/share/kicad/footprints/Connector_Video.pretty \
 && test -x /usr/bin/pcbnew
# Freerouting 2.4.1 is compiled for Java 25 (class file 69); Ubuntu 24.04 ships only 21, so use the Temurin 25 JRE.
RUN mkdir -p /opt/java /opt/fpga/freerouting \
 && curl -fsSL https://api.adoptium.net/v3/binary/latest/25/ga/linux/x64/jre/hotspot/normal/eclipse \
    | tar -xz -C /opt/java --strip-components=1 \
 && curl -fsSL -o /opt/fpga/freerouting/freerouting-2.4.1.jar \
      https://github.com/freerouting/freerouting/releases/download/v2.4.1/freerouting-2.4.1.jar \
 && /opt/java/bin/java -version

COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
# Pillow turns captured frames into JPEGs (same pin as Crusoe-Forge's uv.lock).
RUN uv pip install --python /app/.venv/bin/python pillow==13.0.0
COPY manudesk ./manudesk
COPY designs ./designs
RUN uv sync --frozen --no-dev --inexact

# One work dir per check lives under MANUDESK_WORK (no spaces: EDA tools dislike them).
ENV MANUDESK_TOOLS=/opt/fpga/oss-cad-suite/bin \
    MANUDESK_WORK=/tmp/manudesk \
    LIBGL_ALWAYS_SOFTWARE=1 \
    QT_X11_NO_MITSHM=1 \
    KICAD_BIN=/usr/bin \
    KICAD_PYTHON=/usr/bin/python3 \
    KICAD_FOOTPRINTS=/usr/share/kicad/footprints \
    JAVA21=/opt/java/bin/java \
    FREEROUTING_JAR=/opt/fpga/freerouting/freerouting-2.4.1.jar \
    PATH=/app/.venv/bin:/opt/fpga/oss-cad-suite/bin:$PATH

EXPOSE 8765
CMD ["python", "-m", "manudesk.server", "--transport", "http", "--host", "0.0.0.0", "--port", "8765"]
