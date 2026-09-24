# Cyberdeck

Une boîte à outils web auto-hébergée pour consultants en cybersécurité : **un seul conteneur**, une page d'accueil avec un tiroir par outil, et chaque outil construit avec la techno qui lui va le mieux.

![Cyberdeck](docs/screenshot.png)

| Tiroir | Ce qu'il fait | Techno |
| --- | --- | --- |
| **Whiteboard** | Dessin et schémas avec Excalidraw, planches nommées enregistrées sur le serveur, autosave, export PNG/SVG | React · Excalidraw · Node |
| **CyberChef** | Le build officiel du GCHQ, servi tel quel : encodages, chiffrement, compression, parsing, recettes chaînées | CyberChef (Apache-2.0), téléchargé au build |
| **Copy-paste** | Un texte → un code de 5 caractères + QR + lien ; `curl /p/CODE` depuis un terminal ; expiration, destruction à la lecture | Go |
| **Alpha** | Canal alpha, canaux RVB, 32 bit-planes, détection de pixels cachés sous la transparence, extraction LSB | Python · FastAPI · Pillow · NumPy |
| **JSON** | Validation avec position d'erreur, indentation, compactage, tri des clés, réparation de JSON approximatif, arbre repliable, recherche par chemin | JavaScript vanilla, 100 % navigateur |

## Lancer

```bash
docker run -d --name toolbox -p 7850:8080 -v ./data:/data \
  -e PUBLIC_URL=https://toolbox.example.com \
  ghcr.io/clemdepernet/cyberdeck:latest
```

Ou avec le `docker-compose.yml` fourni. L'image est multi-arch (amd64, arm64 : elle tourne sur un Raspberry Pi 5).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PUBLIC_URL` | déduit de la requête | URL publique, utilisée dans les liens et QR codes des pastes |
| `APP_PASSWORD` | vide (ouvert) | Active une authentification basique sur tout le deck (utilisateur `toolbox`, ou `APP_USER`) |
| `PUID` / `PGID` | 1000 | Propriétaire de `/data` |
| `TZ` | UTC | Fuseau horaire des logs |

`/data` contient un sous-dossier par outil (`whiteboard/`, `paste/`…). Rien d'autre à sauvegarder.

Le deck est pensé pour être exposé derrière un reverse proxy ou un tunnel Cloudflare. Sans `APP_PASSWORD`, tout le monde peut créer des pastes : le service Go limite le débit par IP (création et lecture) et les codes sont tirés dans un alphabet de 31 caractères sur 5 positions.

## Raccourcis

- `Alt+1` … `Alt+9` : changer d'outil, `Alt+0` : replier le bandeau.
- `Ctrl+S` dans le whiteboard : enregistrer maintenant (sinon autosave 1,5 s après le dernier trait).
- `https://…/p/CODE` : ouvre un paste. Avec `curl`, `wget` ou `Accept: text/plain`, renvoie le texte brut.
- Coller une image (`Ctrl+V`) dans Alpha suffit, pas besoin de fichier.
- CyberChef garde ses options (thème sombre, favoris) dans le navigateur, via son menu Options.

## Ajouter un outil

Chaque outil vit dans `tools/<id>/` et décrit lui-même comment il se branche :

```
tools/<id>/
├── tool.json        nom, accroche, techno, icône, ordre → alimente les onglets
├── nginx.conf       ses blocs `location` (statique ou proxy vers son process)
├── supervisor.conf  (optionnel) le process à lancer, sur 127.0.0.1:81xx
└── …                son code, dans la techno de son choix
```

```bash
scripts/new-tool.sh hashes "Hashes" "md5, sha1, sha256 d'un texte ou d'un fichier" "HTML · JavaScript"
docker compose up -d --build
```

Le script crée un outil statique prêt à l'emploi ; l'onglet apparaît au prochain build (le manifeste `shell/tools.json` est généré par `scripts/build-manifest.py`). Pour embarquer une app web existante sans la compiler, copie le modèle du stage `cyberchef-build` (téléchargement d'une release puis `COPY --from`). Pour un outil avec backend, ajoute un `supervisor.conf`, proxy-le depuis son `nginx.conf` et compile-le dans un stage du `Dockerfile` (les stages `whiteboard-build` et `paste-build` servent de modèles).

Conventions qui gardent le deck cohérent :

- Un outil est servi sous `/<id>/` et charge `/theme.css` (palette, boutons, champs) et `/deck.js` (relais des raccourcis clavier depuis l'iframe).
- Ses données vont dans `/data/<id>/`, créé au démarrage avec les bons droits.
- Ses ports sont locaux au conteneur (`127.0.0.1:81xx`) ; seul nginx écoute sur `8080`.
- Un paramètre d'URL peut être passé depuis le shell : `#paste?code=K7X2M` ouvre l'outil avec `?code=K7X2M`.

## Développement

```bash
docker build --target test .        # tests Go, Python et Node dans l'image réelle
docker compose up --build           # le deck sur http://localhost:7850
```

Tests unitaires par outil : `tools/paste` (`go test`), `tools/alpha` (`pytest`), `tools/whiteboard` (`node --test server.test.mjs`).

## Licence

MIT. Excalidraw est sous licence MIT également.
