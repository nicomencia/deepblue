# Despliegue en el portátil Arch (siempre encendido)

Guía para mover deepblue del PC de desarrollo al portátil Arch Linux que hará
de servidor 24/7 en casa (IP residencial — requisito del runner). Todo lo de
abajo se ensayó en producción local el 2026-07-22 antes de tener el portátil:
`pnpm build` + `start:web` + `start:runner` verificados (rutas dev → 404,
las 7 lanes cron → 200 con el secreto auto-emitido, runner arrendando jobs).

## 0. Qué copiar del PC actual (a mano, nunca por git)

| Qué | De dónde | A dónde | Por qué |
|---|---|---|---|
| `apps/web/.env.local` | PC actual | igual | secretos (API keys, RUNNER_TOKEN) |
| `apps/web/.data/pglite/` | PC actual | igual | LA base de datos (corpus, leads, dossiers) |
| `.browser-profile/` | PC actual | igual | sesión Wallapop logueada (opcional: re-login en el portátil) |

Copiar `.data/pglite` SIEMPRE con el servidor de origen parado (single-writer:
una copia con el server vivo sale corrupta). El backup más reciente en
`~/deepblue-backups/` sirve igual (`tar -xzf` en `apps/web/.data/`).

## 1. Preparar el portátil (Arch)

```bash
sudo pacman -S --needed git nodejs npm chromium xorg-server-xvfb tar
sudo corepack enable          # pnpm vía corepack (o: sudo npm i -g pnpm)
node --version                # necesita ≥22 (Arch va por delante — bien)
```

`chromium` de pacman no es el navegador que usará Playwright, pero instala
todas las librerías de sistema que el Chromium empaquetado necesita —
`playwright install-deps` es solo Debian/Ubuntu y aquí no funciona.

**Portátil como servidor:**

```bash
# Tapa cerrada sin suspender
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo sed -i 's/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind

# Nada de suspensión automática
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# Batería siempre enchufada: limitar carga si el firmware lo expone (evita hinchazón)
echo 80 | sudo tee /sys/class/power_supply/BAT0/charge_control_end_threshold 2>/dev/null \
  || echo "este firmware no expone límite de carga — no pasa nada"
```

Ethernet si el portátil tiene puerto; si es WiFi, fijar la red en
NetworkManager y desactivar el ahorro de energía WiFi.

## 2. Clonar, instalar, construir

```bash
git clone https://github.com/nicomencia/deepblue.git ~/deepblue && cd ~/deepblue
pnpm install
pnpm exec playwright install chromium     # el Chromium de Playwright
# (colocar ahora .env.local, .data/pglite y .browser-profile — sección 0)
pnpm typecheck && pnpm test
pnpm build                                # next build (producción)
```

## 3. Primera ejecución manual (antes de systemd)

```bash
pnpm start:web        # backup + next start; NODE_ENV=production
# En otra terminal:
pnpm start:runner
```

Checklist de humo (idéntico al ensayado):

- `curl -s -o /dev/null -w "%{http_code}" localhost:3000/` → **200**
- `curl -s -o /dev/null -w "%{http_code}" localhost:3000/api/dev/state` → **404**
  (las rutas dev no existen en producción — correcto)
- En el log del web, el primer tick del scheduler (~15 s tras arrancar, en
  horario 08–23h Madrid): las 7 lanes `→ 200`. Un `→ 401` aquí = bug
  (el scheduler se auto-emite CRON_SECRET en producción desde 2026-07-22).
- El runner: `runner started, polling http://localhost:3000` y arrienda jobs.

**Login de Wallapop** (si no copiaste `.browser-profile`): con el portátil
abierto una vez, `pnpm runner:login` — sesión con cabeza, entras a mano, se
guarda el perfil persistente. Después ya puede vivir con la tapa cerrada
(los envíos de chat corren bajo Xvfb — pantalla virtual, sigue siendo headed).

## 4. Servicios systemd (arranque automático + reinicio ante fallo)

Los units están en `deploy/`. Editar `User=` y las rutas (`CHANGE_ME`), y la
ruta real de pnpm (`which pnpm`) si no es `/usr/bin/pnpm`:

```bash
sudo cp deploy/deepblue-web.service deploy/deepblue-runner.service \
        deploy/deepblue-backup.service deploy/deepblue-backup.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepblue-web deepblue-runner deepblue-backup.timer
systemctl status deepblue-web deepblue-runner     # ambos "active (running)"
journalctl -u deepblue-web -f                     # el log del cerebro en vivo
```

El timer de backup NO copia nada en caliente: reinicia el web a las 07:30
(ventana de sueño del scheduler) y la cadena de arranque hace el backup con el
puerto libre — el único momento consistente. 14 backups rotados en
`~/deepblue-backups` (`DEEPBLUE_BACKUP_DIR` para moverlos a un disco/dir
sincronizado personal).

## 5. Acceso remoto al panel: Tailscale

```bash
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up          # login una vez (Google/GitHub)
```

Instala Tailscale también en el móvil/PC → el panel queda en
`http://<nombre-del-portatil>:3000` desde cualquier sitio, cifrado, sin abrir
puertos en el router y sin exponer nada a internet. Este es además el primer
escalón del camino "app de control" (ver PROJECT.md): el panel ya es la app;
Tailscale es el transporte privado hasta que exista auth multi-usuario.

## 6. Disciplina de appliance (Arch es rolling)

- **No actualizar por costumbre.** `pacman -Syu` solo deliberado, delante del
  portátil, con tiempo para arreglar. Un appliance quieto no se rompe.
- Actualizar deepblue: `git pull && pnpm install && pnpm build &&
  sudo systemctl restart deepblue-web deepblue-runner`.
- Si el runner pierde la sesión de Wallapop (expiración, logout remoto):
  portátil abierto, `sudo systemctl stop deepblue-runner`, `pnpm runner:login`,
  arrancar de nuevo. El email de "platform_blocked" avisa si algo va mal.

## 7. Vuelta atrás

Todo el estado vive en 3 sitios (`.env.local`, `.data/pglite`,
`.browser-profile`). Copiarlos de vuelta a cualquier máquina con el repo =
mudanza completa. Los backups diarios son la red de seguridad.
