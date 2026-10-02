# Despliegue de WorkDone en máquinas nuevas

Runbook para desplegar el puente Herdr ↔ ChatGPT (WorkDone) desde cero, en máquinas de otra persona. Está escrito para que lo siga un agente de código con acceso a este repositorio y a una terminal en la estación de trabajo, pidiendo al humano solo lo que exige su cuenta o su decisión.

```text
ChatGPT → app MCP (conexión Tunnel) → OpenAI Secure MCP Tunnel
  → tunnel-client en el servidor → MCP en 127.0.0.1:8787 del servidor
  → OpenSSH sobre Tailscale → comando forzado (gateway) en la estación → socket de Herdr
  → OpenSSH a 127.0.0.1    → gateway del propio servidor (opcional)
  → OpenSSH sobre Tailscale → gateway de otras máquinas (opcional, scripts/add-machine.sh)
```

Tres papeles:

- **Estación de trabajo** (macOS o Linux): donde corren Herdr y los agentes. Lleva el gateway. Desde aquí se lanzan los scripts.
- **Servidor** (Linux con systemd, siempre encendido): el MCP, el túnel o túneles de OpenAI y, si se activan los Events nativos, el emisor OAuth.
- **Máquinas extra** (opcional): cualquier equipo con Bun, Herdr y sshd en la tailnet.

Documentos relacionados, que este no repite:

- `README.md`: herramientas, capacidades, alias de agentes, notificaciones, dónde están los controles de seguridad.
- `docs/INSTALL_AND_SETUP.md`: el runbook original y sus restricciones de seguridad. Usa Node y algunos nombres antiguos; donde difiera, manda este documento y el código.
- `docs/mcp-events.md` e `issuer/README.md`: Events nativos y emisor OAuth.
- `docs/chatgpt-link.md`: la tarjeta de enlace, `tell`, las políticas de permisos y la tarjeta de aprobación.

---

## Índice

0. [Convenciones](#0-convenciones)
1. [Valores a rellenar antes de empezar](#1-valores-a-rellenar-antes-de-empezar)
2. [Requisitos por máquina](#2-requisitos-por-máquina)
3. [Fase 1: gateway en la estación](#3-fase-1-gateway-en-la-estación)
4. [Fase 2: base del servidor y clave del puente](#4-fase-2-base-del-servidor-y-clave-del-puente)
5. [Fase 3: authorized_keys en la estación](#5-fase-3-authorized_keys-en-la-estación)
6. [Fase 4: política de Tailscale](#6-fase-4-política-de-tailscale)
7. [Fase 5: fijar la host key y pruebas negativas](#7-fase-5-fijar-la-host-key-y-pruebas-negativas)
8. [Fase 6: servicio MCP en el servidor](#8-fase-6-servicio-mcp-en-el-servidor)
9. [Fase 7: tunnel-client verificado](#9-fase-7-tunnel-client-verificado)
10. [Fase 8: túnel y API key en OpenAI Platform](#10-fase-8-túnel-y-api-key-en-openai-platform)
11. [Fase 9: configurar y arrancar el túnel](#11-fase-9-configurar-y-arrancar-el-túnel)
12. [Fase 10: app y plugin en ChatGPT](#12-fase-10-app-y-plugin-en-chatgpt)
13. [Fase 11: pruebas de aceptación](#13-fase-11-pruebas-de-aceptación)
14. [Fase 12 (opcional): el servidor como máquina y avisos al móvil](#14-fase-12-opcional-el-servidor-como-máquina-y-avisos-al-móvil)
15. [Fase 13 (opcional): máquinas extra](#15-fase-13-opcional-máquinas-extra)
16. [Fase 14 (opcional): capacidades y alias de agentes](#16-fase-14-opcional-capacidades-y-alias-de-agentes)
17. [Fase 15 (opcional, experimental): Events nativos y emisor OAuth](#17-fase-15-opcional-experimental-events-nativos-y-emisor-oauth)
18. [Operación diaria y actualizaciones](#18-operación-diaria-y-actualizaciones)
19. [Rotar la API key del túnel](#19-rotar-la-api-key-del-túnel)
20. [Fallos conocidos y arreglos](#20-fallos-conocidos-y-arreglos)
21. [Valores fijos en los scripts y cómo adaptarlos](#21-valores-fijos-en-los-scripts-y-cómo-adaptarlos)
22. [Desinstalar](#22-desinstalar)

---

## 0. Convenciones

- **[AGENTE]**: lo ejecuta el agente.
- **[HUMANO]**: lo hace la persona dueña de las cuentas. Son pasos en OpenAI Platform, en ChatGPT, en la consola de administración de Tailscale, en los ajustes del sistema, y cualquier paso que toque un secreto. El agente le dice exactamente qué hacer y espera a que confirme.
- Si el clasificador de permisos del agente bloquea un paso (escribir `known_hosts` remotos, copiar el repo al servidor, arrancar el túnel, desplegar), no se rodea: se le da el comando al humano para que lo ejecute él.
- Los comandos marcados "en la estación" se ejecutan desde la raíz del repo clonado (`<REPO_DIR>`). Los marcados "en el servidor" se ejecutan tras `ssh <SERVER_SSH_ALIAS>`.
- Antes de editar cualquier fichero existente, se hace una copia `.bak-AAAAMMDDhhmmss`. Los scripts del repo ya lo hacen con lo que tocan.

### Secretos

Hay tres: la API key de runtime del túnel (`sk-…`), la contraseña del emisor OAuth (solo en la fase 15) y las claves privadas SSH. Reglas:

- El agente nunca imprime, lee, copia ni pega un secreto. Tampoco lee el portapapeles, ni siquiera para comprobar un prefijo.
- Las claves privadas SSH se generan en la máquina que las usa y no salen de ella. Solo viaja la clave pública.
- La API key entra en el servidor por un prompt oculto o por una tubería desde el portapapeles que ejecuta el humano en su propia terminal (fase 9). Llega a `tunnel-client` por entorno, nunca por argumentos visibles en `ps`.
- En el chat con el agente no se pega nunca un secreto.

---

## 1. Valores a rellenar antes de empezar

El agente rellena esta tabla primero (en sus notas, no en el repo) y la usa en todo el documento. Ninguno de estos valores es secreto, pero tampoco se commitean.

| Marcador | Qué es | Cómo obtenerlo |
| --- | --- | --- |
| `<REPO_DIR>` | Ruta del repo clonado en la estación | `pwd` en la raíz del clon |
| `<WORKSTATION_OS>` | `macos` o `linux` | `uname -s` (`Darwin` = macOS) |
| `<WORKSTATION_USER>` | Usuario de la estación | `whoami` |
| `<WORKSTATION_HOME>` | Home absoluto de la estación | `printf '%s\n' "$HOME"` |
| `<WORKSTATION_TAILNET_HOST>` | Nombre MagicDNS de la estación | `tailscale status --json \| jq -r .Self.DNSName \| sed 's/\.$//'` |
| `<WORKSTATION_TAILSCALE_IP>` | IP Tailscale de la estación | `tailscale ip -4` |
| `<WORKSTATION_MACHINE>` | Nombre de la estación para ChatGPT (el parámetro `machine`) | Elección. `mac` encaja con la skill y los ejemplos actuales; en Linux puede ser otro (ver §12.2) |
| `<HERDR_SOCKET>` | Socket de Herdr en la estación | `herdr status server` (normalmente `~/.config/herdr/herdr.sock`) |
| `<BUN_VERSION>` | Versión de Bun de la estación | `bun --version` |
| `<SERVER_SSH_ALIAS>` | Alias SSH del servidor en `~/.ssh/config` de la estación | `grep -i '^Host ' ~/.ssh/config`, y comprobar con `ssh <alias> true` |
| `<SERVER_USER>` | Usuario con el que la estación entra al servidor | `ssh <SERVER_SSH_ALIAS> whoami` |
| `<SERVER_TAILSCALE_IP>` | IP Tailscale del servidor | `ssh <SERVER_SSH_ALIAS> tailscale ip -4` |
| `<SERVER_ARCH>` | `amd64` o `arm64` | `ssh <SERVER_SSH_ALIAS> uname -m` (`x86_64` = amd64, `aarch64` = arm64) |
| `<ALLOWED_ROOT>` | Carpeta de proyectos que ChatGPT podrá ver en la estación | Preguntar al humano. Ni `/` ni `~` (el gateway las rechaza) |
| `<TUNNEL_CLIENT_VERSION>` | Release de `openai/tunnel-client` | `gh release list -R openai/tunnel-client --limit 3` |
| `<TUNNEL_ID>` | ID del túnel (`tunnel_` + 32 hex) | Lo da OpenAI Platform en la fase 8 [HUMANO] |
| `<APP_ID>` | ID de la app en ChatGPT (`asdk_app_…`) | URL de ajustes de la app en la fase 10, sin el prefijo `plugin_` |

Solo para la fase 15 (Events):

| Marcador | Qué es | Cómo obtenerlo |
| --- | --- | --- |
| `<AUTH_PORT>` | Puerto loopback del listener OAuth del MCP | Uno libre en el servidor: `ss -ltn`. Los scripts actuales usan `8789` |
| `<ISSUER_HOST>` | Nombre DNS público del servidor para el emisor | DNS del humano apuntando a la IP pública del servidor |
| `<MCP_RESOURCE>` | URL canónica del recurso MCP con OAuth | `https://<ISSUER_HOST>/mcp` si se usa la ruta pública de §17 |

Comprobación de conectividad antes de seguir (en el servidor):

```bash
tailscale ping -c 1 <WORKSTATION_TAILSCALE_IP>
nc -z -w 3 <WORKSTATION_TAILSCALE_IP> 22 && echo ssh-ok
```

Esperado: `pong from …` y `ssh-ok`. Si no, no se sigue.

---

## 2. Requisitos por máquina

### Estación

- Herdr instalado y su servidor en marcha. `herdr --version` y `herdr status server` responden.
- Bun en `~/.bun/bin/bun` (o en otra ruta, que se pasa con `BUN=`).
- `jq`, `git`, `ssh`, `zip`, `gh` (para verificar `tunnel-client`).
- Tailscale conectado.
- sshd del sistema escuchando en el puerto 22 de la tailnet, **no Tailscale SSH**. Con Tailscale SSH, el servidor SSH de Tailscale atiende el puerto 22 y las restricciones de `authorized_keys` (comando forzado, `from=`) no se aplican.

  ```bash
  tailscale debug prefs | grep RunSSH
  ```

  Esperado: `"RunSSH": false`. Si sale `true`, **[HUMANO]** decide: desactivarlo o usar otro puerto con un sshd normal (ver `docs/INSTALL_AND_SETUP.md`, fase 0). No se desactiva sin permiso.

- macOS: "Sesión remota" activada **[HUMANO]** (Ajustes del Sistema > General > Compartir > Sesión remota). `launchctl` puede mostrar `com.openssh.sshd` como "not running": es normal, launchd arranca sshd por conexión.
- macOS, opcional: para que el gateway lea `~/Downloads`, `~/Documents` o `~/Desktop`, **[HUMANO]** activa "Permitir acceso total al disco para usuarios remotos" en el mismo panel. Afecta a todas las sesiones SSH, no solo al puente.

### Servidor

- Linux con systemd (probado en Debian 12). `sudo` sin contraseña para `<SERVER_USER>`: `scripts/deploy-ovh.sh`, `scripts/add-machine.sh` y `scripts/deploy-issuer.sh` ejecutan `sudo` en sesiones sin terminal.
- Tailscale conectado, en modo TUN (el normal). En modo userspace sshd no ve la IP tailnet del cliente y `from=` deja de servir.
- `curl`, `jq`, `ssh`, `python3` o `unzip`, `ss`.
- Bun `<BUN_VERSION>` en `/usr/local/bin/bun`, la misma versión que la estación (ver fase 2).
- Solo si el servidor va a ser también una máquina de trabajo (fase 12): Herdr con su servidor en marcha para `<SERVER_USER>`, sshd escuchando en `127.0.0.1:22` y `~/.ssh/authorized_keys` existente.
- Solo para la fase 15: Node 24 en `/usr/bin/node`, puertos 80 y 443 públicos y un proxy TLS (Caddy).
- Nada de lo que instala este runbook escucha en una interfaz pública, salvo el emisor y la ruta `/mcp` de la fase 15.

### Verificación

En la estación:

```bash
herdr --version && herdr status server
~/.bun/bin/bun --version
tailscale debug prefs | grep RunSSH
```

En el servidor:

```bash
cat /etc/os-release | head -3; systemctl --version | head -1
sudo -n true && echo sudo-ok
ss -ltn | grep -E ':(8787|8080|8081|8789|8790)\b' || echo puertos-libres
```

Esperado: versiones impresas, `"RunSSH": false`, `sudo-ok`, `puertos-libres`. Si algún puerto está ocupado, se anota y se adapta (ver §21).

---

## 3. Fase 1: gateway en la estación

El gateway es el comando forzado de la clave del puente: lee una petición JSON por línea en stdin y responde una línea en stdout. Hace las comprobaciones de seguridad (raíces permitidas, IDs, capacidades) en la propia estación. Detalle en `README.md`, "Where the security checks live".

**[AGENTE]** En la estación:

```bash
cd <REPO_DIR>
bun install && (cd mcp && bun install)
bun run check                 # tsc + todos los tests
scripts/install-gateway.sh    # BUN=/ruta/a/bun si no está en ~/.bun/bin/bun
```

`install-gateway.sh` copia `gateway/*.ts` y el lanzador a `~/.local/libexec/herdr-chatgpt/` (700/600), escribe `bun-path`, instala `workdone-tell` en `~/.local/bin` y, si no existe, crea `~/.config/herdr-chatgpt/gateway.json` desde `config/mac-gateway.example.json`. Nunca sobrescribe un `gateway.json` existente.

### Editar `gateway.json`

Copia de seguridad primero. Cambios mínimos sobre el ejemplo:

- `allowedRoots`: `["<ALLOWED_ROOT>"]`. Cada raíz tiene que existir. Se rechazan `/` y `~`.
- `repos`: `{}` o los repos reales dentro de las raíces. Un repo fuera de las raíces hace fallar la carga.
- `herdrSocketPath`: `<HERDR_SOCKET>` si no es el de por defecto.
- `agentAliases`: el ejemplo apunta a `~/.config/herdr-chatgpt/agent-aliases.json`. **Si ese fichero no existe, el gateway no arranca.** O se borra la clave por ahora, o se genera el fichero (§16.2).
- `agentKinds`: solo las CLI instaladas en la estación (`claude`, `codex`, `cursor`, `pi`).
- En Linux: `shell` (por ejemplo `/usr/bin/zsh` o `/bin/bash`) y `extraPath` (quitar `/opt/homebrew/bin`).
- Todas las capacidades `allow*` se quedan en `false` en la instalación inicial.

```bash
cp -p ~/.config/herdr-chatgpt/gateway.json ~/.config/herdr-chatgpt/gateway.json.bak-$(date +%Y%m%d%H%M%S)
# editar con jq o con el editor; ejemplo mínimo:
jq --arg root '<ALLOWED_ROOT>' '.allowedRoots = [$root] | .repos = {} | del(.agentAliases)' \
  ~/.config/herdr-chatgpt/gateway.json > /tmp/gw.json && install -m 600 /tmp/gw.json ~/.config/herdr-chatgpt/gateway.json && rm /tmp/gw.json
```

El gateway relee `gateway.json` en cada llamada: no hay nada que reiniciar.

### Verificación

```bash
L=~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
printf '%s\n' \
  '{"id":"1","op":"bridge_status","params":{}}' \
  '{"id":"2","op":"overview","params":{}}' \
  '{"id":"3","op":"get_agent","params":{"target":"--zzbogus"}}' \
  '{"id":"4","op":"run_command_in_pane","params":{"pane_id":"x:p1","command":"id"}}' \
  '{"id":"5","op":"remove_worktree","params":{"workspace_id":"x"}}' \
  '{"id":"6","op":"nope","params":{}}' \
  'not json' | env -i HOME="$HOME" "$L" | jq -c '{id, ok, code: .error.code}'
```

Esperado:

- 1 y 2 con `ok: true`. La respuesta completa de 1 trae `herdr_version` y `allowed_roots`.
- 3 `invalid_params`.
- 4 y 5 `capability_disabled`.
- 6 `unknown_operation`.
- la última `invalid_json`.

Además, `overview` no debe listar agentes cuyo directorio quede fuera de `<ALLOWED_ROOT>`: aparecen como "not found". Cada llamada queda en `~/.local/state/herdr-chatgpt/audit.jsonl`.

---

## 4. Fase 2: base del servidor y clave del puente

### Bun con la misma versión que la estación

El lockfile lo escribe la versión de Bun de la estación. Con otra versión, `bun install --frozen-lockfile` falla con `UnknownLockfileVersion`. Se instala el release oficial en `/usr/local/bin`, verificado, sin tocar un Bun de usuario que ya exista.

**[AGENTE]** En el servidor (`bun-linux-x64.zip` para amd64, `bun-linux-aarch64.zip` para arm64):

```bash
V=<BUN_VERSION>; A=bun-linux-x64
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v$V/$A.zip"
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v$V/SHASUMS256.txt"
grep " $A.zip\$" SHASUMS256.txt | sha256sum -c -
python3 -c "import zipfile; zipfile.ZipFile('$A.zip').extractall('.')"
sudo install -m 755 -o root -g root "$A/bun" /usr/local/bin/bun
/usr/local/bin/bun --version
```

Esperado: `…zip: OK` y la misma versión que `<BUN_VERSION>`.

### Usuario de servicio, directorios y clave

```bash
id herdr-mcp 2>/dev/null || sudo useradd --system --home /var/lib/herdr-mcp --create-home --shell /usr/sbin/nologin herdr-mcp
sudo install -d -m 750 -o root -g herdr-mcp /etc/herdr-mcp
sudo install -d -m 700 -o herdr-mcp -g herdr-mcp /etc/herdr-mcp/ssh
sudo test -e /etc/herdr-mcp/ssh/id_ed25519 || \
  sudo -u herdr-mcp ssh-keygen -q -t ed25519 -a 100 -N "" -C herdr-chatgpt-bridge -f /etc/herdr-mcp/ssh/id_ed25519
```

La clave privada no sale del servidor. Es una clave dedicada: no se usa ninguna clave personal.

### Verificación

```bash
sudo ls -l /etc/herdr-mcp/ssh/
sudo ssh-keygen -lf /etc/herdr-mcp/ssh/id_ed25519.pub
```

Esperado: `id_ed25519` con `-rw------- herdr-mcp`, y una huella `SHA256:… herdr-chatgpt-bridge (ED25519)`.

---

## 5. Fase 3: authorized_keys en la estación

La línea queda así:

```text
from="<SERVER_TAILSCALE_IP>",restrict,command="<WORKSTATION_HOME>/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh" ssh-ed25519 AAAA… herdr-chatgpt-bridge
```

`from=` acepta la clave solo desde la IP Tailscale del servidor, `restrict` quita PTY, reenvíos y agente, y `command=` fuerza el gateway. El lanzador ignora `SSH_ORIGINAL_COMMAND` y lo audita como `ssh_command_ignored`.

**[AGENTE]** En la estación:

```bash
install -d -m 700 ~/.ssh
[ -e ~/.ssh/authorized_keys ] && cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-$(date +%Y%m%d%H%M%S)
ssh <SERVER_SSH_ALIAS> 'sudo cat /etc/herdr-mcp/ssh/id_ed25519.pub' > /tmp/bridge.pub
scripts/render-authorized-key.sh <SERVER_TAILSCALE_IP> \
  "$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh" /tmp/bridge.pub >> ~/.ssh/authorized_keys
rm /tmp/bridge.pub
chmod 600 ~/.ssh/authorized_keys
```

La ruta del lanzador no puede tener espacios ni comillas (el script lo rechaza).

### Verificación

```bash
tail -1 ~/.ssh/authorized_keys | cut -c1-120
diff <(sed '$d' ~/.ssh/authorized_keys) "$(ls -t ~/.ssh/authorized_keys.bak-* | head -1)" && echo claves-previas-intactas
```

Esperado: la línea empieza por `from="<SERVER_TAILSCALE_IP>",restrict,command="/…/herdr-gateway-launcher.sh"`, y `claves-previas-intactas` (si había un fichero previo).

---

## 6. Fase 4: política de Tailscale

**[HUMANO]** Abrir la política de la tailnet en la consola de administración de Tailscale (Access controls) y leerla. No se reemplaza.

- Si es la política por defecto (`"src": ["*"], "dst": ["*:*"]`), cualquier dispositivo llega a cualquier puerto. Añadir una regla concreta no restringe nada mientras exista esa. Restringir de verdad exige quitar el "accept all", y eso afecta a todos los dispositivos de la tailnet: es decisión del humano, no del agente.
- Si ya hay reglas concretas, se añade la mínima: el servidor llega al puerto 22 de la estación (y de cada máquina extra). Con etiquetas o con selectores existentes, lo que no amplíe otros accesos. Ejemplo en `docs/INSTALL_AND_SETUP.md`, fase 3.

Aunque la política sea abierta, el acceso queda limitado por `from=` en la clave, el comando forzado y el MCP escuchando solo en loopback.

### Verificación

En el servidor:

```bash
nc -z -w 3 <WORKSTATION_TAILSCALE_IP> 22 && echo ssh-ok
```

Esperado: `ssh-ok`.

---

## 7. Fase 5: fijar la host key y pruebas negativas

No se usa nunca `StrictHostKeyChecking=no`. La host key de la estación se toma por una vía local de confianza (leyéndola en la propia estación) y se compara con la que ve el servidor por la red.

**[AGENTE]** En la estación:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh <SERVER_SSH_ALIAS> 'ssh-keyscan -t ed25519 <WORKSTATION_TAILNET_HOST> 2>/dev/null | ssh-keygen -lf -'
```

Las dos huellas tienen que ser iguales. Si no lo son, se para y se avisa al humano.

Con las huellas iguales, se escribe `known_hosts` en el servidor con el nombre MagicDNS y la IP:

```bash
echo "<WORKSTATION_TAILNET_HOST>,<WORKSTATION_TAILSCALE_IP> $(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub)" \
  | ssh <SERVER_SSH_ALIAS> 'sudo -u herdr-mcp tee /etc/herdr-mcp/ssh/known_hosts >/dev/null && sudo chmod 644 /etc/herdr-mcp/ssh/known_hosts'
```

Este paso lo puede bloquear el clasificador de permisos del agente. En ese caso lo ejecuta el humano.

### Pruebas desde el servidor como `herdr-mcp`

En el servidor. Son las mismas opciones de `ssh` que usa el servicio:

```bash
s() { sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -i /etc/herdr-mcp/ssh/id_ed25519 \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
  -o ForwardAgent=no -o ClearAllForwardings=yes -o RequestTTY=no "$@"; }
T=<WORKSTATION_USER>@<WORKSTATION_TAILNET_HOST>
B='{"id":"1","op":"bridge_status","params":{}}'

echo "$B" | s -T "$T" | jq -c '{ok, herdr: .result.herdr_version}'                  # 1
echo "$B" | s -T "$T" 'id; cat ~/.ssh/authorized_keys' | jq -c '{ok}'                # 2
s -T "$T" </dev/null; echo "exit $?"                                                  # 3
echo 'uname -a' | s -T "$T" | jq -c .error.code                                       # 4
echo '{"id":"1","op":"nope","params":{}}' | s -T "$T" | jq -c .error.code             # 5
echo '{"id":"1","op":"run_command_in_pane","params":{"pane_id":"x:p1","command":"id"}}' | s -T "$T" | jq -c .error.code   # 6
sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -i /etc/herdr-mcp/ssh/id_ed25519 -o BatchMode=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts -tt "$T" </dev/null 2>&1 | head -2   # 7
(timeout 6 sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -i /etc/herdr-mcp/ssh/id_ed25519 -o BatchMode=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts -T -N -L 12345:127.0.0.1:22 "$T" &
  sleep 2; nc -w 2 127.0.0.1 12345 </dev/null; wait) 2>&1 | grep -i prohibited             # 8
```

| # | Esperado |
| --- | --- |
| 1 | `{"ok":true,"herdr":"…"}` |
| 2 | `{"ok":true}`: se ejecuta el gateway y el comando pedido se ignora. En la estación, `audit.jsonl` tiene una entrada `ssh_command_ignored` |
| 3 | error `empty_input`, `exit 65` |
| 4 | `"invalid_json"` |
| 5 | `"unknown_operation"` |
| 6 | `"capability_disabled"` |
| 7 | `PTY allocation request failed on channel 0` |
| 8 | el reenvío falla (`administratively prohibited`) y `nc` no conecta |

Antes de fijar la host key, cualquier llamada falla con `Host key verification failed.`: es el comportamiento correcto.

---

## 8. Fase 6: servicio MCP en el servidor

### Copiar el código

El servidor puede no tener `rsync`. Se copia con `tar` sobre `ssh`, igual que hacen los scripts.

**[AGENTE]** En la estación:

```bash
COPYFILE_DISABLE=1 tar -C <REPO_DIR> --no-xattrs --exclude=node_modules --exclude=.git --exclude=dist -czf - . |
  ssh <SERVER_SSH_ALIAS> 'rm -rf ~/herdr-chatgpt-bridge-staging && mkdir -m 700 ~/herdr-chatgpt-bridge-staging && tar -C ~/herdr-chatgpt-bridge-staging -xzf -'
```

En el servidor:

```bash
sudo rm -rf /opt/herdr-chatgpt-bridge
sudo cp -r ~/herdr-chatgpt-bridge-staging /opt/herdr-chatgpt-bridge
sudo chown -R root:root /opt/herdr-chatgpt-bridge
cd /opt/herdr-chatgpt-bridge/mcp
sudo /usr/local/bin/bun install --frozen-lockfile
sudo /usr/local/bin/bun test 2>&1 | tail -3
```

Sin `--production`: los tests del MCP usan una dependencia de desarrollo. Esperado: los tests terminan con `0 fail`.

### Configuración `/etc/herdr-mcp/ovh.json`

El nombre del fichero es fijo (lo usan la unidad y los scripts). La clave dentro de `machines` es el nombre que ChatGPT pasa como `machine`.

```bash
sudo tee /etc/herdr-mcp/ovh.json >/dev/null <<'EOF'
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "machines": {
    "<WORKSTATION_MACHINE>": {
      "binary": "/usr/bin/ssh",
      "user": "<WORKSTATION_USER>",
      "host": "<WORKSTATION_TAILNET_HOST>",
      "port": 22,
      "identityFile": "/etc/herdr-mcp/ssh/id_ed25519",
      "knownHostsFile": "/etc/herdr-mcp/ssh/known_hosts",
      "connectTimeoutSeconds": 10
    }
  },
  "defaultMachine": "<WORKSTATION_MACHINE>",
  "requestTimeoutMs": 130000
}
EOF
sudo chown root:herdr-mcp /etc/herdr-mcp/ovh.json
sudo chmod 640 /etc/herdr-mcp/ovh.json
```

La carga falla si `listen.host` no es loopback o si `user`/`host` empiezan por `-` o llevan caracteres raros. `notify` se añade en la fase 12.

### Unidades

```bash
sudo install -m 644 /opt/herdr-chatgpt-bridge/deploy/systemd/herdr-mcp.service /etc/systemd/system/
sudo install -m 644 /opt/herdr-chatgpt-bridge/deploy/systemd/openai-herdr-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now herdr-mcp.service
```

La unidad del túnel se instala ahora pero no se habilita: lo hace el script de la fase 9. `herdr-mcp.service` corre como `herdr-mcp`, con `ProtectSystem=strict` y `IPAddressDeny=any` más `IPAddressAllow=localhost 100.64.0.0/10 fd7a:115c:a1e0::/48`: solo habla con loopback y la tailnet.

### Verificación

En el servidor:

```bash
systemctl is-active herdr-mcp
curl -s http://127.0.0.1:8787/healthz; echo
ss -ltnp | grep 8787
mcp() { curl -s -X POST 127.0.0.1:8787/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$1"; }
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_status","arguments":{}}}' |
  jq -r '.result.content[0].text' | jq -c 'to_entries[] | {machine: .key, herdr: .value.herdr_version, error: .value.error.code}'
```

En la estación:

```bash
nc -z -w 3 <SERVER_TAILSCALE_IP> 8787 && echo ABIERTO || echo cerrado
```

Esperado:

- `active`
- `{"ok":true,"service":"herdr-mcp"}`
- el listener es `127.0.0.1:8787`, nunca `0.0.0.0` ni `[::]`
- un número de herramientas mayor que cero (cambia con la versión)
- una línea por máquina con `herdr` y `error: null`
- `cerrado` desde la estación

Si `bridge_status` devuelve `error`, revisar `sudo journalctl -u herdr-mcp -n 50 --no-pager` y repetir las pruebas de la fase 5.

---

## 9. Fase 7: tunnel-client verificado

Solo el binario oficial de `openai/tunnel-client`, con checksum y procedencia verificados. Se descarga y verifica en la estación (tiene `gh`) y se copia al servidor.

**[AGENTE]** En la estación, en un directorio temporal:

```bash
V=<TUNNEL_CLIENT_VERSION>; ARCH=<SERVER_ARCH>
gh release view $V -R openai/tunnel-client --json assets --jq '.assets[].name'   # comprobar nombres
gh release download $V -R openai/tunnel-client \
  -p "tunnel-client-$V-linux-$ARCH.zip" -p SHA256SUMS.txt -p "tunnel-client-$V-provenance.sigstore.json"
SHA=$(gh api repos/openai/tunnel-client/git/ref/tags/$V --jq .object.sha)
grep "tunnel-client-$V-linux-$ARCH.zip\$" SHA256SUMS.txt | shasum -a 256 -c -
gh attestation verify "tunnel-client-$V-linux-$ARCH.zip" \
  --bundle "tunnel-client-$V-provenance.sigstore.json" \
  --repo openai/tunnel-client \
  --signer-workflow openai/tunnel-client/.github/workflows/release.yml \
  --source-ref "refs/tags/$V" --source-digest "$SHA" --signer-digest "$SHA" \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
scp "tunnel-client-$V-linux-$ARCH.zip" <SERVER_SSH_ALIAS>:/tmp/
```

Si `SHA256SUMS.txt` lista más de un zip para esa arquitectura (por ejemplo una variante `runtime`), el `grep` tiene que quedarse solo con el que se descargó.

En el servidor:

```bash
cd /tmp && sha256sum tunnel-client-<TUNNEL_CLIENT_VERSION>-linux-<SERVER_ARCH>.zip   # igual que en la estación
rm -rf tc-x && python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall("tc-x")' tunnel-client-<TUNNEL_CLIENT_VERSION>-linux-<SERVER_ARCH>.zip
sudo install -d -m 755 /opt/tunnel-client
sudo cp -r tc-x/. /opt/tunnel-client/
sudo chown -R root:root /opt/tunnel-client
sudo chmod 755 /opt/tunnel-client/tunnel-client
/opt/tunnel-client/tunnel-client --version
```

El zip trae también `cloudflared`. No se usa salvo con opciones `--cloudflared.*`, que este despliegue no activa.

### Verificación

Esperado: `…zip: OK`, `gh attestation verify` con salida 0, el mismo sha256 en las dos máquinas y `tunnel-client --version` con la versión y el commit del tag.

---

## 10. Fase 8: túnel y API key en OpenAI Platform

Todo **[HUMANO]**. El agente le da estas instrucciones y espera los dos valores no secretos: `<TUNNEL_ID>` y la confirmación de que la key está creada y copiada.

### Túnel

En `https://platform.openai.com/settings/organization/tunnels` → "Create tunnel":

| Campo | Valor |
| --- | --- |
| Name | Uno descriptivo, por ejemplo `workdone-mcp` |
| Description | Opcional, por ejemplo "Herdr MCP on my server (127.0.0.1:8787)" |
| Organizations | La organización de la API key |
| ChatGPT workspaces | **El mismo workspace o cuenta de ChatGPT en el que se usará WorkDone** |

Si la lista no se refresca tras "Create", recargar la página. Anotar `<TUNNEL_ID>`.

Si la persona tiene varias cuentas de ChatGPT (personal y de empresa), hay que marcar la que usa de verdad. Si el túnel queda en otra, ChatGPT dirá "No tunnels yet". Tras guardar un cambio de workspace, ChatGPT tarda unos 30 segundos en ofrecer el túnel.

### API key de runtime

En `https://platform.openai.com/settings/organization/api-keys` → "Create new secret key":

| Campo | Valor |
| --- | --- |
| Name | Por ejemplo `workdone-tunnel-runtime` |
| Permissions | **Restricted** |
| Permiso concedido | **Tunnels: Read + Use** |
| Resto de permisos | None |
| Expiration | Decisión del humano. Sin caducidad, el puente no se rompe cada mes; con caducidad, hay que rotarla (§19) antes de que expire |

Nunca una key "All" ni una admin key para el demonio.

El humano pulsa "Copy" él mismo. Un clic desde una automatización de navegador puede no llegar al portapapeles del sistema, y entonces se pega otra cosa. La key no se pega en el chat.

---

## 11. Fase 9: configurar y arrancar el túnel

`scripts/ovh-setup-tunnel.sh` (ya copiado en `/opt/herdr-chatgpt-bridge/scripts/`):

1. lee la key de un prompt oculto o de stdin;
2. comprueba su forma sin imprimirla (empieza por `sk-`, sin espacios ni comillas) y, si no cuadra, sale con "nothing written";
3. respalda el `tunnel.env` anterior y escribe `/etc/herdr-mcp/tunnel.env` (600, `herdr-mcp`);
4. ejecuta como `herdr-mcp` `tunnel-client init --sample sample_mcp_remote_no_auth --profile herdr-mcp …` y `doctor`;
5. habilita y reinicia `openai-herdr-tunnel.service` y muestra `/readyz`.

**[HUMANO]** en su propia terminal de la estación, con una de estas dos formas:

```bash
# A) prompt oculto: pegar la key cuando lo pida
ssh -t <SERVER_SSH_ALIAS> 'sudo sh /opt/herdr-chatgpt-bridge/scripts/ovh-setup-tunnel.sh <TUNNEL_ID>'

# B) desde el portapapeles (macOS), y vaciarlo después
pbpaste | ssh <SERVER_SSH_ALIAS> 'sudo sh /opt/herdr-chatgpt-bridge/scripts/ovh-setup-tunnel.sh <TUNNEL_ID>'; pbcopy </dev/null
```

En Linux, la forma B es `wl-paste | ssh …; wl-copy --clear` (Wayland) o `xclip -selection clipboard -o | ssh …` (X11). La forma B necesita `sudo` sin contraseña en el servidor, porque stdin lleva la key.

El agente no ejecuta ninguna de las dos: leer el portapapeles o recibir la key es materializar una credencial.

### Verificación

**[AGENTE]** en el servidor:

```bash
systemctl is-active openai-herdr-tunnel
curl -s 127.0.0.1:8080/readyz; echo
curl -s 127.0.0.1:8080/api/status | jq .
sudo journalctl -u openai-herdr-tunnel -n 30 --no-pager -o cat | grep -E 'started|initialized|error' | tail -5
```

Esperado: `active`, `ready`, el canal `main` con `"enabled": true` y una línea `tunnel-client started` en el journal. Si `journalctl` muestra `control plane API key is malformed` con reinicios cada 5 s, la key que entró no era la buena: repetir la fase 9 con la key copiada a mano.

El perfil queda en `/etc/herdr-mcp/tunnel-client/herdr-mcp.yaml` y no contiene la key (`api_key: "env:CONTROL_PLANE_API_KEY"`).

---

## 12. Fase 10: app y plugin en ChatGPT

En ChatGPT hay dos objetos distintos y hacen falta los dos:

| Objeto | Qué es |
| --- | --- |
| **App** (`asdk_app_…`) | La conexión por el túnel y las herramientas MCP |
| **Plugin** | La skill `herdr-remote` y el enlace a la app. Es lo que se invoca con `@` |

**No se borra la app aunque parezca un duplicado del plugin.** Sin ella, el plugin dice "No app tools available yet" y ChatGPT responde "No tool was defined".

### 12.1 Crear la app [HUMANO]

En `https://chatgpt.com/plugins` → "+" → "Create app" → en el diálogo, "Create MCP App". Si no aparece la opción, puede hacer falta activar el modo desarrollador en los ajustes de ChatGPT.

| Campo | Valor |
| --- | --- |
| Name | Por ejemplo `WorkDone Tunnel` (distinto del plugin, para no confundirlos) |
| Description | Por ejemplo "Connection used by the WorkDone plugin. Use the plugin, not this app." |
| Connection | **Tunnel** |
| Available tunnels | El de `<TUNNEL_ID>` |
| Authentication | **No Auth** (este MCP no tiene OAuth en el puerto 8787; por defecto viene "OAuth") |
| "I understand and want to continue" | Marcado |

Tras "Create", ChatGPT muestra "… is now connected". El ID aparece en la URL de ajustes de la app como `plugin_asdk_app_…`. **El ID de la app es la parte `asdk_app_…`, sin el prefijo `plugin_`.** Ese es `<APP_ID>`.

### 12.2 Adaptar y empaquetar el plugin [AGENTE]

El plugin del repo describe el despliegue original. Antes de empaquetarlo, el agente revisa con el humano:

- `plugin/herdr-remote/.codex-plugin/plugin.json`: `description`, `interface.shortDescription`, `longDescription`, `developerName`, `author.name` y `defaultPrompt` nombran máquinas y repos concretos. Se cambian por los de este despliegue.
- `plugin/herdr-remote/skills/herdr-remote/SKILL.md`: nombra las máquinas `mac`, `ovh` y una tercera, usa un repo de ejemplo concreto, y tiene una sección sobre un navegador remoto que solo vale si hay un navegador configurado en el gateway (`browser` en `gateway.json`). Se ajustan los nombres de máquina a los de `ovh.json` y se quita esa sección si no aplica.

Después:

```bash
cd <REPO_DIR>
cp plugin/herdr-remote/.app.json.example plugin/herdr-remote/.app.json
jq --arg id '<APP_ID>' '.apps["herdr-remote"].id = $id' plugin/herdr-remote/.app.json > /tmp/app.json && mv /tmp/app.json plugin/herdr-remote/.app.json
mkdir -p dist
(cd plugin && zip -qr -X ../dist/herdr-remote-plugin.zip herdr-remote \
  -x '*.DS_Store' -x 'herdr-remote/.gitignore' -x 'herdr-remote/.app.json.example')
unzip -l dist/herdr-remote-plugin.zip
```

`.app.json` está ignorado por git: el ID es de esa cuenta y no se commitea. Esperado en `unzip -l`: `.codex-plugin/plugin.json`, `.app.json` y `skills/herdr-remote/SKILL.md`.

### 12.3 Subir e instalar el plugin [HUMANO]

- Primera vez: `https://chatgpt.com/plugins` → "+" → "Upload plugin" → `dist/herdr-remote-plugin.zip`. Esperado: "Import successful".
- Si el error dice `apps.herdr-remote.id must begin with asdk_app_, connector_, or templated_apps_`, el ID lleva el prefijo `plugin_`: quitarlo y volver a empaquetar.
- En la página del plugin, "Install plugin".
- Versiones siguientes: en la página del plugin, menú "…" → **Upload new version**. "Add → Upload plugin archive" desde la lista crea un plugin nuevo, y con el mismo zip falla ("Couldn't add plugin").

### Verificación

**[HUMANO]** En un chat nuevo: `@<nombre del plugin> what are my Herdr agents doing right now?`.

**[AGENTE]** En la estación:

```bash
tail -n 5 ~/.local/state/herdr-chatgpt/audit.jsonl | jq -c '{op, ok, client}'
```

Esperado: ChatGPT responde con la lista de agentes y el audit tiene entradas nuevas (`overview` u otras) con `client` igual a `<SERVER_TAILSCALE_IP>`.

---

## 13. Fase 11: pruebas de aceptación

Desde un chat nuevo con el plugin. El agente comprueba cada una en `audit.jsonl` o en el journal del servidor.

| # | Prueba | Esperado |
| --- | --- | --- |
| 1 | `bridge_status` | responde con la versión de Herdr y las raíces |
| 2 | `overview` | solo agentes dentro de las raíces permitidas |
| 3 | Leer un agente (`read_agent`) | texto de la pantalla o de la última respuesta |
| 4 | Arrancar un agente de prueba en una carpeta desechable dentro de la raíz (`spawn_agent`) y pedirle algo inocuo | responde; el primer prompt espera a que esté `idle` |
| 5 | `run_command_in_pane` | `capability_disabled` |
| 6 | `remove_worktree` | `capability_disabled` |
| 7 | **[HUMANO]** lo pide; **[AGENTE]** para el túnel: `sudo systemctl stop openai-herdr-tunnel` | ChatGPT pierde el acceso; ningún puerto nuevo abierto (`ss -ltn` igual que antes) |
| 8 | `sudo systemctl start openai-herdr-tunnel` | `/readyz` vuelve a `ready` y ChatGPT recupera el acceso |
| 9 | `sudo systemctl restart herdr-mcp` | el túnel se reinicia con él (`Requires=`), espera al `/healthz` del MCP (`ExecStartPre`) y el canal vuelve con `"enabled": true` |

Al terminar, cerrar el agente de prueba y borrar la carpeta desechable.

---

## 14. Fase 12 (opcional): el servidor como máquina y avisos al móvil

### 14.1 Gateway del servidor

Con esto ChatGPT también controla los agentes de Herdr del servidor, que sigue encendido cuando la estación duerme. Lo hace `scripts/deploy-ovh.sh`, desde la estación:

- copia el repo al servidor e instala el gateway para `<SERVER_USER>` con `config/ovh-gateway.example.json` (raíz `~/src`, capacidades apagadas);
- crea `/etc/herdr-mcp/ssh/id_ed25519_ovh` y la añade a `~/.ssh/authorized_keys` de `<SERVER_USER>` con `from="127.0.0.1"` y el comando forzado;
- fija la host key del servidor para `127.0.0.1`;
- prueba `bridge_status` por esa clave;
- despliega el MCP en `/opt/herdr-chatgpt-bridge` (la versión anterior queda en `/opt/herdr-chatgpt-bridge.old-<fecha>`);
- añade `machines.ovh` y `notify: {machine: "ovh"}` a `ovh.json` si faltan, y reinicia `herdr-mcp`.

Requisitos previos en el servidor: Herdr en marcha para `<SERVER_USER>`, `~/.ssh/authorized_keys` existente (`touch` y `chmod 600` si no), sshd escuchando en `127.0.0.1:22`, `jq` y `sudo` sin contraseña. **El nombre de máquina queda fijo como `ovh`** (ver §21).

Antes de ejecutarlo, revisar `~/.config/herdr-chatgpt/gateway.json` en el servidor si ya existe; si no, el script lo crea desde el ejemplo, que trae una sección `browser` y una raíz `~/src` que hay que ajustar (y `~/src` tiene que existir).

**[AGENTE]** en la estación (si el clasificador lo bloquea, lo ejecuta el humano):

```bash
scripts/deploy-ovh.sh <SERVER_SSH_ALIAS>
```

Verificación: la salida termina con una línea por máquina, `{"machine":"<WORKSTATION_MACHINE>","herdr":"…",…}` y `{"machine":"ovh","herdr":"…",…}`, sin `error`, y con la orden de rollback.

### 14.2 Avisos al móvil

El MCP lleva un notificador: vigila los agentes que tienen trabajo pendiente y manda un aviso al terminar o al pararse en una pregunta. Lo envía por el gateway de `notify.machine` en `ovh.json`, que ejecuta su `notifyCommand` con el mensaje como último argumento. Detalle en `README.md`, "Notifications and offline machines".

- Conviene que `notify.machine` sea una máquina siempre encendida (el servidor). Si apunta a la estación, los avisos esperan a que despierte.
- `deploy-ovh.sh` solo rellena `notifyCommand` si existe un script de notificaciones en una ruta concreta del autor. En otro caso, se pone a mano en el `gateway.json` de esa máquina. Cualquier comando que acepte el mensaje como último argumento vale, por ejemplo `["/usr/local/bin/mi-notificador", "--title", "WorkDone", "--message"]`. El canal (ntfy, Pushover, correo) lo decide el humano; sus credenciales las pone él.
- Sin `notify` en `ovh.json`, no hay avisos al móvil.
- No se instala `scripts/install-watcher.sh` (el watcher de launchd) junto al notificador del MCP: los dos trabajarían sobre la misma lista. El watcher solo sirve para un despliegue de una sola máquina sin servidor.

Verificación:

```bash
printf '%s\n' '{"id":"1","op":"notify","params":{"message":"WorkDone test"}}' | ~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
```

ejecutado en la máquina de `notify.machine`. Esperado: `{"ok":true,…"exit_code":0}` y el aviso en el móvil. Avisar al humano antes: es un mensaje real.

---

## 15. Fase 13 (opcional): máquinas extra

`scripts/add-machine.sh NOMBRE ALIAS_SSH '~/carpeta' ...` se ejecuta desde la estación y:

- instala el gateway en la máquina (todas las capacidades apagadas, la config solo se crea si no existe);
- crea en el servidor `/etc/herdr-mcp/ssh/id_ed25519_NOMBRE` y añade en la máquina la línea de `authorized_keys` con `from=<SERVER_TAILSCALE_IP>` y el comando forzado;
- fija en el servidor la host key de la máquina, comparando la que lee en la máquina con la que ve `ssh-keyscan` desde el servidor (si no coinciden, para);
- añade `machines.NOMBRE` a `ovh.json` y termina con `scripts/deploy-ovh.sh`.

Requisitos en la máquina: Bun en `~/.bun/bin/bun`, servidor de Herdr en marcha, `/etc/ssh/ssh_host_ed25519_key.pub` legible, sshd normal (no Tailscale SSH). En la estación, `ALIAS_SSH` tiene que resolver a una dirección de la tailnet (`100.x` o `*.ts.net`) que el servidor también alcance, porque el script copia host, puerto y usuario de `ssh -G ALIAS_SSH`. `NOMBRE` cumple `^[a-z][a-z0-9-]{0,15}$`. Como termina con `deploy-ovh.sh`, también necesita lo de §14.1.

**[AGENTE]** en la estación:

```bash
OVH_HOST=<SERVER_SSH_ALIAS> scripts/add-machine.sh <NOMBRE> <ALIAS_SSH> '~/src'
```

Las raíces van entre comillas simples para que la estación no expanda `~`. Si el servidor no puede leer su propia IP Tailscale, se pasa `OVH_TAILNET_IP=<SERVER_TAILSCALE_IP>`.

Verificación: la salida de `deploy-ovh.sh` al final incluye una línea con `"machine":"<NOMBRE>"` y su versión de Herdr. Las últimas líneas impresas dan el comando para activar capacidades en esa máquina. `machine` es texto libre en las herramientas, así que ChatGPT no necesita **Refresh tools** para ver una máquina nueva.

### Herdr en una máquina Linux sin escritorio

- Arranque manual: `setsid nohup herdr server >~/.local/state/herdr-server.log 2>&1 &`. El repo no trae unidad para arrancar Herdr tras un reinicio: hay que añadir una (unidad de usuario de systemd, `@reboot` de cron o el programador de tareas del sistema).
- Si el servidor de Herdr arrancó con un `PATH` mínimo, los paneles no encuentran `claude`, `codex` ni `cursor-agent`. Arreglo sin reiniciar Herdr: en `~/.config/herdr/config.toml`, `[terminal] default_shell = "/ruta/a/la/shell"` y `shell_mode = "login"`, y luego `herdr server reload-config`. Los paneles nuevos leen el perfil de login.
- En algunos NAS `scp` falla. Para copiar un fichero: `ssh ALIAS 'cat > ruta' < fichero`.

---

## 16. Fase 14 (opcional): capacidades y alias de agentes

### 16.1 Capacidades

Todas empiezan apagadas. La tabla de qué abre cada una está en `README.md`. Las activa el humano, máquina por máquina, editando `gateway.json`; el agente puede preparar el comando, pero no lo ejecuta sin su decisión explícita. Con `allowExec`, las raíces dejan de ser un límite para todo salvo las herramientas de ficheros: un comando puede ir a cualquier sitio al que llegue el usuario.

```bash
cd ~/.config/herdr-chatgpt && b=gateway.json.bak-$(date +%Y%m%d%H%M%S) && cp -p gateway.json "$b" &&
  jq '.allowFileRead = true' "$b" > gateway.json.new && install -m 600 gateway.json.new gateway.json && rm gateway.json.new
```

Otros interruptores útiles:

- `"execInPane": true`: `exec` corre en una pestaña de Herdr dentro de la shell interactiva del usuario, con su `.zshrc`, su llavero y su ssh-agent. Sin esto, `exec` corre como el login SSH del gateway, y herramientas que guardan el token en el llavero de macOS (por ejemplo `gh`) fallan con 401.
- `"autoApprove": false`: apaga la aprobación automática de menús.
- `"leases": false`: apaga los leases por conversación (no recomendado con varios chats a la vez).

Verificación: `bridge_status` en esa máquina muestra la capacidad en `capabilities`.

### 16.2 Alias de agentes

ChatGPT arranca agentes por alias (aves, árboles, animales), nunca por CLI o modelo. En cada máquina:

```bash
bun scripts/agent-aliases.ts        # escribe ~/.config/herdr-chatgpt/agent-aliases.json e imprime el mapa
```

y en su `gateway.json`, `"agentAliases": "~/.config/herdr-chatgpt/agent-aliases.json"`. En máquinas sin el repo, copiar el script o copiar el fichero generado en la estación, para que los nombres coincidan.

**Aviso para el humano:** el script añade a cada alias las opciones de acceso total de cada CLI (`FULL_ACCESS` en el script): Claude Code arranca con `--dangerously-skip-permissions` y Codex con `--dangerously-bypass-approvals-and-sandbox`. Los agentes harán commits, pushes y borrados sin pedir permiso. Si no se quiere, editar `FULL_ACCESS` antes de generar el fichero. Lo que deba seguir siendo decisión del dueño necesita además una protección fuera del agente (por ejemplo, protección de rama en GitHub).

Cada CLI necesita su sesión iniciada en cada máquina (`claude`, `codex login`, `cursor-agent login`…), **[HUMANO]**. Las sesiones OAuth no se copian entre máquinas: compartir un refresh token puede cerrar la sesión en una de ellas.

Verificación: `bridge_status` lista los alias en `agent_kinds`.

---

## 17. Fase 15 (opcional, experimental): Events nativos y emisor OAuth

Con Events, ChatGPT recibe `agent.finished` y `agent.asks` por webhook firmado, sin tarjeta abierta. Requiere una conexión OAuth real. El código está, pero **a la fecha de este documento no se ha completado una suscripción real desde ChatGPT**: en la última prueba registrada, la conexión OAuth quedó hecha y ChatGPT listó los eventos, pero nunca llamó a `events/subscribe`. Mantener la tarjeta de `watch_here` (`docs/chatgpt-link.md`) como camino principal.

La referencia es `docs/mcp-events.md` (protocolo, grants, política de red, pruebas) e `issuer/README.md` (emisor). Aquí va el orden y lo que el despliegue registrado aprendió.

### 17.1 Decisiones previas [HUMANO]

- Exponer en público el emisor y la ruta `/mcp` del listener OAuth (puertos 80 y 443). `/mcp` responde 401 sin un token válido, pero queda en Internet.
- Un nombre DNS `<ISSUER_HOST>` apuntando al servidor.
- La contraseña del dueño del emisor. Quien la tenga puede ejecutar comandos en las máquinas por ChatGPT: larga, en un gestor de contraseñas.

### 17.2 Listener OAuth en el MCP [AGENTE]

Se añade a `/etc/herdr-mcp/ovh.json` (copia antes), conservando `machines`, `defaultMachine` y `notify`:

```json
"auth": {
  "listenPort": <AUTH_PORT>,
  "resource": "<MCP_RESOURCE>",
  "issuer": "https://<ISSUER_HOST>",
  "jwksPath": "/etc/herdr-mcp/issuer-jwks.json",
  "grantsPath": "/etc/herdr-mcp/principal-grants.json",
  "requiredScopes": ["workdone"],
  "algorithms": ["RS256"]
},
"events": {
  "statePath": "/var/lib/herdr-mcp/events.sqlite",
  "callbackHosts": ["<ISSUER_HOST>"]
}
```

- Con `auth.listenPort`, el mismo proceso sirve el 8787 sin autenticación (la app de la fase 10 sigue funcionando) y `<AUTH_PORT>` con OAuth. Sin `listenPort`, el 8787 pasa a exigir token y la app No Auth deja de funcionar.
- `callbackHosts` lleva al principio un nombre propio como marcador. El host real del callback de ChatGPT se lee del journal (`callback_host`) en la primera suscripción y se sustituye (`docs/mcp-events.md`, "Callback network policy").
- `principal-grants.json`: `{"subjects": {"owner": {"scopes": ["workdone"], "machines": ["<WORKSTATION_MACHINE>"]}}}`, `root:herdr-mcp`, 640. `owner` es el `OWNER_SUBJECT` del emisor.
- `issuer-jwks.json` se copia del emisor en 17.3.

El MCP no arranca con `auth` sin el JWKS, así que este cambio se reinicia después de 17.3.

### 17.3 Emisor [AGENTE + HUMANO]

`scripts/deploy-issuer.sh` está hecho para un servidor concreto (Caddy dentro de un contenedor Docker, red puente de Docker, nombre por defecto fijo; ver §21). En otro servidor se hace a mano, con Caddy instalado en el sistema:

```bash
# en la estación: copiar el emisor
(cd <REPO_DIR> && tar -cf - --exclude node_modules issuer/src issuer/package.json issuer/bun.lock issuer/tsconfig.json) |
  ssh <SERVER_SSH_ALIAS> 'rm -rf /tmp/wd-issuer && mkdir /tmp/wd-issuer && tar -xf - -C /tmp/wd-issuer'
```

```bash
# en el servidor
node --version                                   # 24.x
sudo rm -rf /opt/workdone-issuer && sudo mkdir /opt/workdone-issuer
sudo cp -r /tmp/wd-issuer/issuer/. /opt/workdone-issuer/ && sudo chown -R root:root /opt/workdone-issuer
(cd /opt/workdone-issuer && sudo /usr/local/bin/bun install --frozen-lockfile --production)
id workdone-issuer >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/workdone-issuer --shell /usr/sbin/nologin workdone-issuer
sudo install -d -m 700 -o workdone-issuer -g workdone-issuer /var/lib/workdone-issuer
sudo install -d -m 750 -o root -g workdone-issuer /etc/workdone-issuer
printf 'ISSUER_URL=https://%s\nMCP_RESOURCE=%s\nOWNER_SUBJECT=owner\n' '<ISSUER_HOST>' '<MCP_RESOURCE>' |
  sudo tee /etc/workdone-issuer/env >/dev/null
sudo chown root:workdone-issuer /etc/workdone-issuer/env && sudo chmod 640 /etc/workdone-issuer/env
```

Claves y contraseña, **[HUMANO]** en el servidor (la contraseña va por stdin y no queda en el historial):

```bash
read -rs PW && printf '%s\n' "$PW" | sudo -u workdone-issuer /usr/local/bin/bun /opt/workdone-issuer/src/setup.ts /var/lib/workdone-issuer; unset PW
```

`setup.ts` escribe `signing-key.json`, `cookie-keys.json`, `password-hash` (600) y `jwks.json` (público). Se niega a sustituir una clave de firma existente; `--rotate-password` cambia solo la contraseña.

Unidad: la del repo exige Docker (`Requires=docker.service`) porque el emisor original escuchaba en la red puente de Docker. Sin Docker, se instala sin esa dependencia y el emisor escucha en `127.0.0.1:8790` (valor por defecto):

```bash
sed -e '/^Requires=docker.service/d' -e 's/ docker.service//' -e '/^# Listens on the Docker bridge/d' \
  /opt/herdr-chatgpt-bridge/deploy/systemd/workdone-issuer.service |
  sudo tee /etc/systemd/system/workdone-issuer.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now workdone-issuer
curl -fsS http://127.0.0.1:8790/healthz && echo
```

JWKS y grants para el MCP, y reinicio:

```bash
sudo install -m 640 -o root -g herdr-mcp /var/lib/workdone-issuer/jwks.json /etc/herdr-mcp/issuer-jwks.json
# escribir /etc/herdr-mcp/principal-grants.json (17.2), root:herdr-mcp 640
sudo systemctl restart herdr-mcp
curl -s 127.0.0.1:<AUTH_PORT>/healthz; echo
```

### 17.4 Ruta pública con Caddy [AGENTE, tras la decisión de 17.1]

El MCP solo acepta cabeceras `Host` de loopback (protección contra DNS rebinding), así que Caddy la reescribe. Todo lo que no es `/mcp` va al emisor, que también sirve los metadatos del recurso protegido en su origen. Bloque para `/etc/caddy/Caddyfile` (adaptado de `deploy/Caddyfile.issuer`, que apunta a la red de Docker):

```caddy
<ISSUER_HOST> {
	encode zstd gzip
	handle /mcp* {
		reverse_proxy 127.0.0.1:<AUTH_PORT> {
			header_up Host 127.0.0.1:<AUTH_PORT>
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8790
	}
}
```

```bash
sudo cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)
# añadir el bloque
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Con Caddy en el propio sistema no hacen falta `workdone-mcp-bridge.socket` ni `.service`: solo existen para que un Caddy en Docker llegue al loopback del servidor.

Verificación:

```bash
curl -s https://<ISSUER_HOST>/.well-known/openid-configuration | jq -c '{code_challenge_methods_supported, client_id_metadata_document_supported}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<ISSUER_HOST>/mcp -H 'content-type: application/json' -d '{}'
```

Esperado: `{"code_challenge_methods_supported":["S256"],"client_id_metadata_document_supported":true}` y `401`.

### 17.5 Conexión en ChatGPT [HUMANO]

- Crear una **segunda** app MCP (no tocar la de la fase 10): conexión **Server URL** con `<MCP_RESOURCE>`, autenticación **OAuth**. Iniciar sesión en la página del emisor con la contraseña y aprobar. La interacción de inicio de sesión caduca a los 10 minutos.
- Opcional: empaquetar `plugin/workdone-events/` igual que en 12.2 (su `.app.json` con el ID de esta segunda app) y subirlo.
- **Refresh tools** en los ajustes de la app y comprobar que aparecen `agent.finished` y `agent.asks`.
- Esta app es el mismo MCP: un chat que la use tiene todas las herramientas de WorkDone, no solo eventos.

Sobre el segundo túnel: `scripts/ovh-setup-events-tunnel.sh <TUNNEL_ID_2>` y `deploy/systemd/openai-herdr-events-tunnel.service` montan un túnel aparte hacia el listener OAuth. En el despliegue registrado, ChatGPT no consiguió descubrir el OAuth por el túnel ("Couldn't discover OAuth settings", "Couldn't create MCP app") y se pasó a la ruta pública de 17.4. Si se prueba, adaptar el puerto y `MCP_OAUTH_TRUSTED_ORIGINS` (§21).

Lo que falta después (suscripción en un chat, leer `callback_host`, generar la política de salida con `scripts/events-egress-policy.ts`, entrega real, baja) está en `docs/mcp-events.md`, "Prove it in ChatGPT".

### 17.6 Limpieza de secretos

- Si se generó la contraseña en un fichero, el humano la guarda en su gestor y borra el fichero.
- Revocar: borrar el sujeto de `principal-grants.json` corta el acceso al momento. Borrar `/var/lib/workdone-issuer/oidc.sqlite` olvida todas las autorizaciones.

---

## 18. Operación diaria y actualizaciones

Estado y logs (en el servidor):

```bash
systemctl is-active herdr-mcp openai-herdr-tunnel
curl -s 127.0.0.1:8787/healthz; echo; curl -s 127.0.0.1:8080/readyz; echo
sudo journalctl -u herdr-mcp -n 50 --no-pager
sudo journalctl -u openai-herdr-tunnel -n 50 --no-pager -o cat
```

Diagnóstico del túnel (la key sale del `EnvironmentFile` y no se imprime):

```bash
sudo systemd-run --wait --pipe -p User=herdr-mcp -p EnvironmentFile=/etc/herdr-mcp/tunnel.env \
  -E TUNNEL_CLIENT_PROFILE_DIR=/etc/herdr-mcp/tunnel-client -E HOME=/var/lib/herdr-mcp \
  /opt/tunnel-client/tunnel-client doctor --profile herdr-mcp --explain
```

Con el servicio en marcha, todo da PASS salvo `health_listener` ("address already in use"), porque el puerto 8080 lo tiene el propio servicio. Sin OAuth, `oauth_metadata` da PASS con "all candidates returned HTTP 404".

Auditoría en cada máquina: `tail -f ~/.local/state/herdr-chatgpt/audit.jsonl`.

Actualizar:

| Qué | Cómo |
| --- | --- |
| Gateway de la estación | `scripts/install-gateway.sh`. No toca `gateway.json` |
| Gateway del servidor y MCP | `scripts/deploy-ovh.sh <SERVER_SSH_ALIAS>` (requiere §14.1). Sin gateway en el servidor: repetir la copia de §8 sobre `/opt/herdr-chatgpt-bridge.new`, cambiar los directorios y `sudo systemctl restart herdr-mcp` |
| Máquinas extra | Volver a ejecutar `scripts/add-machine.sh` con los mismos argumentos (es idempotente y no toca su `gateway.json`) |
| Plugin | Editar `plugin/herdr-remote/`, reempaquetar (12.2) y "Upload new version" (12.3) |
| Herramientas nuevas o cambiadas | **[HUMANO]** ajustes de ChatGPT → Plugins → la app → **Manage app** → **Refresh tools**, y abrir un chat nuevo: los chats abiertos siguen con la lista vieja |
| Repos y raíces | Editar `repos` y `allowedRoots` en `gateway.json`; vale desde la siguiente llamada |

Si una máquina duerme o sale de la tailnet, sus llamadas devuelven `machine_offline` durante 60 s y los listados no la esperan.

---

## 19. Rotar la API key del túnel

1. **[HUMANO]** Crear una key nueva con la configuración de la fase 8 (Restricted, solo Tunnels Read + Use) y pulsar "Copy" a mano.
2. **[HUMANO]** Ejecutar la fase 9 con la key nueva.
3. **[AGENTE]** Comprobar `curl -s 127.0.0.1:8080/readyz` → `ready`. Si hay túnel de Events, `sudo systemctl restart openai-herdr-events-tunnel` (lee el mismo `tunnel.env`) y comprobar su `/readyz` en el 8081.
4. **[HUMANO]** Revocar la key anterior en la página de API keys.

---

## 20. Fallos conocidos y arreglos

| Síntoma | Causa | Arreglo |
| --- | --- | --- |
| `bun install` en el servidor: `UnknownLockfileVersion` | Bun del servidor distinto del de la estación | Instalar en `/usr/local/bin/bun` la versión de la estación (fase 2) |
| El gateway no arranca: error al leer `agent-aliases.json` | `gateway.json` del ejemplo apunta a un fichero de alias que no existe | Generarlo (§16.2) o quitar `agentAliases` |
| `allowed root is too broad` o `repo … is outside allowedRoots` | Raíz `/` o `~`, o repo fuera de las raíces | Raíces concretas que existan; repos dentro |
| `Host key verification failed` | `known_hosts` del servidor vacío o con otra clave | Repetir la fase 5 comparando huellas. Nunca `StrictHostKeyChecking=no` |
| `Permission denied (publickey)` desde el servidor | Línea de `authorized_keys` ausente, `from=` con otra IP, o Tailscale SSH atendiendo el 22 | Revisar la línea y `RunSSH`. Si sshd ve `127.0.0.1` u otra IP en vez de la tailnet, Tailscale corre en modo userspace |
| `tunnel-client init` falla justo tras escribir `tunnel.env` | `runuser` conserva el directorio actual y `herdr-mcp` no puede leerlo | El script ya hace `cd /tmp`; si se ejecuta a mano, igual |
| El script dice "that does not look like an OpenAI API key" | El portapapeles no tenía la key (clic de "Copy" automatizado que no llegó) | El humano pulsa "Copy" y repite |
| `control plane API key is malformed`, reinicio cada 5 s | `tunnel.env` con contenido que no es la key | Repetir la fase 9; si la key se llegó a exponer, rotarla |
| Aviso `OAuth discovery failed … invalid character` en el túnel | Un 404 con cuerpo de texto en `/.well-known/…`; `tunnel-client` lo lee como JSON | El MCP actual responde 404 sin cuerpo. Si aparece, el código desplegado es antiguo |
| ChatGPT: "No tunnels yet" | Túnel asociado a otro workspace de ChatGPT | Editar el túnel en Platform, marcar el workspace correcto, esperar unos 30 s |
| Subida del plugin rechazada: `apps.herdr-remote.id must begin with asdk_app_…` | Se copió `plugin_asdk_app_…` de la URL | Quitar `plugin_`, reempaquetar |
| "Couldn't add plugin" al subir una versión | Se usó "Add → Upload plugin archive", que crea otro plugin | Página del plugin → "…" → "Upload new version" |
| ChatGPT: "No tool was defined"; el plugin dice "No app tools available yet" | Se borró la app pensando que era un duplicado | Recrear la app (fase 10.1), poner el ID nuevo en `.app.json`, "Upload new version" |
| Herramientas nuevas no aparecen | ChatGPT guarda la lista de herramientas | **Refresh tools** y chat nuevo. Si se hace con automatización de navegador, el botón tiene que estar a la vista antes del clic |
| Tras reiniciar `herdr-mcp`, ChatGPT pierde WorkDone varios minutos | `tunnel-client` prueba el MCP una sola vez al arrancar y deja el canal desactivado (`/api/status`: `"enabled": false`, `initial mcp probe failed`) | La unidad actual espera al `/healthz` en `ExecStartPre`. Reinstalar la unidad del repo si es antigua |
| Primer prompt a un agente recién arrancado: `agent_not_ready` | El agente aún no está `idle` | Esperar `idle` (`wait_agent`); `spawn_agent` ya lo hace |
| `list_dir ~/Downloads` en macOS: `permission_denied` | Carpetas protegidas por privacidad | "Acceso total al disco para usuarios remotos" (§2), o no usarlas |
| `exec` de `gh` u otra CLI da 401, en un panel funciona | El login SSH del gateway no tiene llavero, ssh-agent ni `.zshrc` | `"execInPane": true` en esa máquina |
| Los paneles de una máquina no encuentran `claude`/`codex` | Servidor de Herdr arrancado con `PATH` mínimo | `default_shell` y `shell_mode = "login"` en la config de Herdr y `herdr server reload-config` (§15) |
| El primer carácter de un comando escrito en un panel nuevo se pierde | Un aviso interactivo de la shell (por ejemplo la actualización de oh-my-zsh) se come la tecla | Quitar el aviso, por ejemplo `zstyle ':omz:update' mode reminder` |
| Un agente aparece como `agent: null` o "gone" aunque sigue vivo | Algo lo paró con SIGSTOP y, tras SIGCONT, quedó en segundo plano | `fg` en la shell del panel y `watch_agent` otra vez. No parar procesos de agentes desde fuera |
| Codex falla al guardar la confianza de carpeta o en `account/read` | La CLI se actualizó a mitad de sesión y quedó desfasada de su app-server | Cerrar y reabrir el agente; misma versión de Codex en todas las máquinas |
| `scp` falla contra una máquina | Algunos NAS no lo aceptan | `ssh ALIAS 'cat > ruta' < fichero` |
| Puerto ocupado (8787, 8080, 8081, `<AUTH_PORT>`, 8790) | Otro servicio en el servidor | Elegir otro y cambiarlo en todas partes (§21) |
| ChatGPT: "Couldn't discover OAuth settings" con conexión Tunnel + OAuth | Descubrimiento OAuth por el túnel no funcionó en la prueba registrada | Ruta pública con Caddy y conexión Server URL (§17.4) |
| El intercambio de token OAuth falla por el método de autenticación del cliente | El documento de cliente de ChatGPT declara `private_key_jwt` y su petición de token llegó como cliente público | El emisor ya acepta `none` y `private_key_jwt`. Si el journal del emisor sigue mostrando `grant.error`, añadir en `/var/lib/workdone-issuer/clients.json` un cliente público estático con `client_id` `https://chatgpt.com/oauth/client.json` y las `redirect_uris` del error. No verificado fuera del despliegue original |
| `invalid_token` en todas las llamadas OAuth | `ISSUER_URL` ≠ `auth.issuer` o `MCP_RESOURCE` ≠ `auth.resource` | Igualarlos y reconectar en ChatGPT |
| El clasificador de permisos del agente bloquea un paso | Política automática del agente (escrituras remotas, despliegues, credenciales) | No se rodea: el humano ejecuta el comando |

---

## 21. Valores fijos en los scripts y cómo adaptarlos

Los scripts se escribieron para un despliegue concreto. Lo que lleva fijo:

| Fichero | Valor fijo | Cómo adaptarlo |
| --- | --- | --- |
| `scripts/deploy-ovh.sh` | Alias SSH por defecto `ovh` | Pasar `<SERVER_SSH_ALIAS>` como primer argumento, o crear `Host ovh` en `~/.ssh/config` |
| `scripts/deploy-ovh.sh` | Nombre de máquina `ovh` en `machines.ovh`, `notify.machine` y la clave `id_ed25519_ovh` | Aceptarlo, o editar el script. Ese nombre lo ve ChatGPT |
| `scripts/deploy-ovh.sh` | Gateway del servidor obligatorio (falla si `bridge_status` local no responde) | Sin Herdr en el servidor, actualizar a mano (§18) |
| `scripts/deploy-ovh.sh` | `notifyCommand` solo si existe un script de notificaciones en una ruta del autor | Poner `notifyCommand` a mano (§14.2) |
| `scripts/deploy-ovh.sh`, `scripts/add-machine.sh` | `sudo` sin contraseña, `/usr/local/bin/bun` en el servidor, `~/.bun/bin/bun` en las máquinas extra | Cumplir esos requisitos |
| `scripts/add-machine.sh`, `scripts/deploy-issuer.sh` | Servidor `ovh` por defecto | `OVH_HOST=<SERVER_SSH_ALIAS>` |
| `scripts/add-machine.sh` | `agentKinds: ["claude","codex"]` y `extraPath` con `~/.npm-global/bin` en la config nueva | Editar el `gateway.json` de la máquina después |
| `scripts/install-gateway.sh` | Crea `gateway.json` desde `config/mac-gateway.example.json` también en Linux (`shell` `/bin/zsh`, `/opt/homebrew/bin`, alias que pueden no existir) | Editarlo (fase 1) |
| `scripts/install-watcher.sh` y `deploy/launchd/*.plist` | Etiqueta de launchd con el prefijo del autor | Solo cosmético; normalmente no se instala (§14.2) |
| `scripts/ovh-setup-tunnel.sh` | Puertos 8787 (MCP) y 8080 (salud del túnel) | Si cambian, editar el script, `ovh.json` y el `ExecStartPre` de `openai-herdr-tunnel.service` |
| `scripts/ovh-setup-events-tunnel.sh` | Puerto OAuth `8789`, admin `8081`, sample `sample_mcp_with_dcr` | Editar si `<AUTH_PORT>` es otro. El sample no se ha visto funcionar con ChatGPT (§17.5) |
| `deploy/systemd/openai-herdr-events-tunnel.service` | `MCP_OAUTH_TRUSTED_ORIGINS` con el nombre del emisor original y `ExecStartPre` contra `8789` | Poner `https://<ISSUER_HOST>` y `<AUTH_PORT>` |
| `scripts/deploy-issuer.sh` | Nombre por defecto atado a la IP del servidor original, Caddy dentro de un contenedor Docker concreto (nombre de contenedor y ruta del Caddyfile fijos), emisor en `172.24.0.1:8790` | No usarlo tal cual: procedimiento manual de §17.3 y §17.4 |
| `deploy/Caddyfile.issuer` | Nombre del emisor original y direcciones de la red Docker (`172.24.0.1:8790`, `:8792`) | Bloque de §17.4 |
| `deploy/systemd/workdone-issuer.service` | `Requires=docker.service` | Quitarlo si no hay Docker (§17.3) |
| `deploy/systemd/workdone-mcp-bridge.{socket,service}` | `172.24.0.1:8792` → `127.0.0.1:8789` | Solo hacen falta con Caddy en Docker |
| `plugin/herdr-remote/` | Nombres de máquina, repos, sección de navegador y autor | Revisar antes de empaquetar (§12.2) |
| `plugin/workdone-events/.codex-plugin/plugin.json` | Menciona las máquinas del autor | Ajustar el texto |
| `config/ovh-gateway.example.json` | Sección `browser` con rutas de una herramienta del autor | Quitarla salvo que esa herramienta exista |

---

## 22. Desinstalar

**[HUMANO]** En ChatGPT: desinstalar y borrar el plugin, y después borrar la app (y la de Events si existe).

**[HUMANO]** En OpenAI Platform: borrar el túnel o túneles y revocar la API key.

**[AGENTE]** En el servidor:

```bash
sudo systemctl disable --now openai-herdr-events-tunnel workdone-issuer 2>/dev/null || true
sudo systemctl disable --now openai-herdr-tunnel herdr-mcp
sudo rm -f /etc/systemd/system/openai-herdr-tunnel.service /etc/systemd/system/openai-herdr-events-tunnel.service \
  /etc/systemd/system/herdr-mcp.service /etc/systemd/system/workdone-issuer.service
sudo rm -rf /etc/systemd/system/herdr-mcp.service.d
sudo systemctl daemon-reload
sudo rm -rf /etc/herdr-mcp /opt/herdr-chatgpt-bridge /opt/herdr-chatgpt-bridge.old-* /opt/tunnel-client /var/lib/herdr-mcp
sudo rm -rf /etc/workdone-issuer /opt/workdone-issuer /var/lib/workdone-issuer
sudo userdel herdr-mcp; sudo userdel workdone-issuer 2>/dev/null || true
sudo rm /usr/local/bin/bun            # solo si nada más lo usa
```

Quitar también el bloque de Caddy si se añadió, y en el servidor la línea `herdr-chatgpt-ovh-local` de `~/.ssh/authorized_keys` y `~/.local/libexec/herdr-chatgpt`, `~/.config/herdr-chatgpt`, `~/.local/state/herdr-chatgpt` si se instaló su gateway.

**[AGENTE]** En la estación y en cada máquina extra:

```bash
cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-uninstall
grep -v 'herdr-chatgpt' ~/.ssh/authorized_keys.bak-uninstall > ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys
rm -rf ~/.local/libexec/herdr-chatgpt ~/.config/herdr-chatgpt ~/.local/state/herdr-chatgpt ~/.local/bin/workdone-tell
```

El `grep -v` quita toda línea que mencione `herdr-chatgpt` (los comentarios de las claves del puente y la ruta del lanzador). Revisar el resultado con `diff` antes de cerrar la sesión SSH.
