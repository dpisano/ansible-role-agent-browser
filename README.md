# ansible-role-agent-browser

Builds a Proxmox VM with a full Linux desktop that runs real browsers for AI agents (Claude Code and others) to drive over MCP, and that a person can watch and take over through noVNC. The agent reads pages and clicks through them; when a site puts up a CAPTCHA or a "checking your browser" page, you open noVNC and solve it in the same tab, and the agent carries on with the cookie it left behind.

What ends up on the VM:

| | What it is | How an agent reaches it |
|---|---|---|
| **Brave** | Stock Brave from Brave's apt repository, own profile, DevTools (CDP) on localhost | **Playwright MCP** over HTTP (attached to the running Brave over CDP); **chrome-devtools-mcp** started over SSH |
| **BrowserOS** | Chromium fork with an MCP server built in | Its MCP server (localhost), forwarded by socat |
| **Camoufox** | Firefox fork that fakes its fingerprint in C++, run by [camofox-browser](https://github.com/redf0x1/camofox-browser) | [camofox-mcp](https://github.com/redf0x1/camofox-mcp) over HTTP, bearer token |
| **noVNC** | x11vnc on the live desktop, behind websockify | You, in a web browser |

All of them run on one XFCE desktop (Xorg, logged in automatically), so the agent, noVNC and the Proxmox console see the same screen. Only Tailscale reaches the MCP servers and noVNC (ufw); SSH is also open to the LAN.

## Requirements

- Proxmox VE, with `qm` on the node the build play runs on, and a storage that allows snippets (the role turns it on).
- The `community.general` collection (`timezone`, `locale_gen`, `npm`, `ufw`).
- Optional, a GPU for the VM as a Proxmox **PCI resource mapping** (Datacenter > Resource Mappings), e.g. an SR-IOV virtual function of an Intel Arc Pro B70. Without one, WebGL reports a software renderer (llvmpipe), which bot checks flag.
- Tailscale on the VM, e.g. with `artis3n.tailscale.machine` in the provision play (see the example). The role only opens the firewall on `tailscale0`.

## How it runs

The role has two phases, run as separate plays:

1. **build** (`agent_browser_phase: build`, on the Proxmox node): creates the VM from the Ubuntu 26.04 cloud image (q35, host CPU, virtio display, Intel HDA sound card, the GPU mapping), or starts it if it exists, waits for its address and adds it to the in-memory group `agent_browser_build`. A VMID without the `agent-browser` tag is never touched.
2. **provision** (`agent_browser_phase: provision`, on `agent_browser_build`, over SSH through the node): kernel extras and firmware, time zone and locale, the desktop and fonts, Node.js, the browsers and MCP servers, the session services, the firewall; then it checks every service listens, asks Brave which WebGL renderer it gets (and fails if a GPU is passed through but the renderer is a software one), and prints how to connect.

Run the playbook again to apply changes; provisioning is idempotent. Changes to services or settings restart the desktop session (LightDM logs the user straight back in).

## Role variables

The main ones; see [`defaults/main.yml`](defaults/main.yml) for all of them.

| Variable | Default | |
|---|---|---|
| `agent_browser_phase` | `build` | `build` or `provision` |
| `agent_browser_vmid` / `agent_browser_vm_name` | `9130` / `agent-browser` | |
| `agent_browser_cores` / `agent_browser_memory` / `agent_browser_disk` | `6` / `16384` / `80` | MiB and GiB |
| `agent_browser_storage` / `agent_browser_bridge` / `agent_browser_vlan` | `local-lvm` / `vmbr0` / `""` | |
| `agent_browser_ip` / `agent_browser_gateway` / `agent_browser_dns` | `""` | Empty: DHCP (give it a reservation by MAC) |
| `agent_browser_gpu_mapping` | `""` | PCI resource mapping to pass through |
| `agent_browser_timezone` | `""` | **Required.** Match where your internet address is |
| `agent_browser_vnc_password` | `""` | **Required.** noVNC password (VNC uses only the first 8 characters) |
| `agent_browser_camofox_mcp_api_key` | `""` | **Required with Camoufox**, 32+ characters |
| `agent_browser_browseros_enabled` / `agent_browser_camoufox_enabled` | `true` / `true` | |
| `agent_browser_rebuild` | `false` | Destroy the VM (and its browser profiles) and build it again |
| `agent_browser_user` | `browser` | The desktop login; everything runs as this user |
| `agent_browser_ssh_allow_from` | `[10.0.0.0/8]` | Networks allowed to SSH in; must include the node |
| `agent_browser_*_version` | pinned | Playwright MCP, chrome-devtools-mcp, camofox-browser, camofox-mcp, BrowserOS |

Ports: noVNC `6080`, Playwright MCP `8931`, BrowserOS MCP `9240` (forwarded to `9239` on localhost), camofox-mcp `9378`; Brave's CDP `9222` and camofox-browser `9377` stay on localhost.

## Example playbook

```yaml
- name: Create the agent browser VM
  hosts: pve-01
  become: true
  vars:
    agent_browser_phase: build
    agent_browser_vlan: 23
    agent_browser_gpu_mapping: arc-b70-vf1
    agent_browser_timezone: America/New_York
  roles:
    - agent-browser

- name: Provision the agent browser VM
  hosts: agent_browser_build
  gather_facts: false
  pre_tasks:
    # The VM may still be booting: wait for SSH before gathering facts.
    - name: Wait for SSH
      ansible.builtin.wait_for_connection:
        timeout: 300
    - name: Gather facts
      ansible.builtin.setup:
  roles:
    - role: infisical-secrets
      vars:
        infisical_secrets: [AGENT_BROWSER_VNC_PASSWORD, AGENT_BROWSER_CAMOFOX_MCP_API_KEY]
    - role: artis3n.tailscale.machine
      vars:
        tailscale_up_skip: true
    - role: agent-browser
      vars:
        agent_browser_phase: provision
        agent_browser_timezone: America/New_York
        agent_browser_gpu_mapping: arc-b70-vf1
        agent_browser_vnc_password: "{{ infisical_secret_values.AGENT_BROWSER_VNC_PASSWORD }}"
        agent_browser_camofox_mcp_api_key: "{{ infisical_secret_values.AGENT_BROWSER_CAMOFOX_MCP_API_KEY }}"
```

## Connecting

After `sudo tailscale up` on the VM, with `<vm>` its Tailscale name:

```bash
# Brave, through Playwright MCP (attached to the Brave on the desktop)
claude mcp add --transport http brave http://<vm>:8931/mcp
# Brave, through chrome-devtools-mcp (network, console, performance)
claude mcp add brave-devtools -- ssh browser@<vm> chrome-devtools-mcp --browser-url=http://127.0.0.1:9222
# BrowserOS
claude mcp add --transport http browseros http://<vm>:9240/mcp
# Camoufox
claude mcp add --transport http camoufox http://<vm>:9378/mcp --header "Authorization: Bearer <key>"
```

noVNC: `http://<vm>:6080/vnc.html`. Camoufox's window appears on the desktop when an agent opens its first tab.

## Security

The MCP servers (camofox-mcp aside) and CDP have no authentication: whoever reaches them controls the browsers and every site they are signed in to. Keep the firewall as it is, keep sensitive accounts (email, banking) out of these profiles, and remember that pages the agent reads can carry instructions aimed at it.

## Bot detection

Real browsers with long-lived profiles, on your own internet address, with a real GPU, get through far more checks than headless automation. What can still give them away: the CDP connection itself (Playwright and Puppeteer call `Runtime.enable`, which some vendors detect), CDP's synthetic input, and a software WebGL renderer when no GPU is passed through. Hardening the first two (a patched driver such as Patchright, OS-level input through xdotool) is not part of this role yet.

## License

MIT
