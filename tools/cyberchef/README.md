# CyberChef

Not built here: the Dockerfile stage `cyberchef-build` downloads the official
release zip from https://github.com/gchq/CyberChef/releases (Apache-2.0) and
serves it as-is under `/cyberchef/`. Bump `CYBERCHEF_VERSION` / `CYBERCHEF_ZIP`
in the Dockerfile to upgrade.
