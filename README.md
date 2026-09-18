# Render MCP Server (personnalisé)

Serveur MCP qui expose des outils pour piloter un compte Render : services, déploiements, variables d'environnement, logs, bases Postgres.

## Configuration requise sur Render

Une fois le service déployé, ajoute cette variable d'environnement dans le dashboard Render (Settings → Environment) :

- `RENDER_API_KEY` : ta clé API Render personnelle, à générer sur https://dashboard.render.com/u/settings#api-keys

## Utilisation dans Claude

Une fois déployé, ajoute l'URL suivante comme connecteur personnalisé dans Claude :

```
https://<nom-du-service>.onrender.com/mcp
```

## Outils disponibles

- `list_services` — liste tous les services
- `get_service` — détails d'un service
- `list_deploys` — historique des déploiements
- `trigger_deploy` — déclenche un déploiement
- `list_env_vars` / `update_env_vars` — gère les variables d'environnement
- `list_postgres` — liste les bases Postgres
- `list_logs` — logs récents d'un service
