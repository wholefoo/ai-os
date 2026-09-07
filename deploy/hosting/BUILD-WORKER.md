# Isolated Web Studio builds

Generated builds intentionally fail closed until an isolated build worker is installed. The image recipe is `deploy/hosting/Dockerfile.build`. On the intended build host, an operator can build it with:

```sh
docker build -f deploy/hosting/Dockerfile.build -t aios-web-build:local .
```

Configure `AIOS_BUILD_IMAGE=aios-web-build:local` for the application, or use a reviewed immutable image digest. Build requests use `--pull=never`; dependency installation happens only when an operator builds the image, never from tenant input. The application needs an available Docker CLI/engine with the staged-source directory accessible to that engine. Prefer a dedicated/rootless build host. The supplied application Compose file does not mount a Docker socket into the app. No image build, dependency download, Docker installation, or socket permission change was performed during this repair.

The updated root-owned `deploy/hosting/site-vhost.sh` must be installed together with the application change, since publishing now uses `--preserve-existing`. Deploy the updated nginx policy and reload nginx after validation. A real container-host reachability test, HTTPS publication/republication, and microphone session remain deployment acceptance checks.

