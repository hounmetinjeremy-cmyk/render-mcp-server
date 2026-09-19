import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const RENDER_API_BASE = "https://api.render.com/v1";
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const DEFAULT_OWNER_ID = process.env.RENDER_OWNER_ID || "tea-d9sqp7jm8hqs73c200t0";

// Lien secret d'autorisation : connu seulement du propriétaire.
// Doit être défini via la variable d'environnement AUTHORIZE_SECRET sur Render.
const AUTHORIZE_SECRET = process.env.AUTHORIZE_SECRET;

if (!RENDER_API_KEY) {
  console.warn(
    "⚠️  RENDER_API_KEY n'est pas défini. Ajoute-le dans les variables d'environnement du service Render."
  );
}
if (!AUTHORIZE_SECRET) {
  console.warn(
    "⚠️  AUTHORIZE_SECRET n'est pas défini. La page d'autorisation ne sera pas accessible tant que ce n'est pas fait."
  );
}

// Tokens d'accès actifs (générés après clic sur "Autoriser").
// Stockage en mémoire : un redémarrage du service les efface, il faudra
// ré-autoriser. C'est un choix volontaire de simplicité pour un usage mono-utilisateur.
const activeTokens = new Set();

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function renderRequest(path, options = {}) {
  const res = await fetch(`${RENDER_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    throw new Error(
      `Render API error ${res.status}: ${JSON.stringify(body)}`
    );
  }
  return body;
}

function toContent(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

// Chemins bloqués sur l'outil generique render_api : forcent l'utilisation
// des outils dedies (create_web_service, etc.) qui sont plus fiables.
const BLOCKED_GENERIC_ROUTES = [
  { method: "POST", pattern: /^\/services\/?$/, useInstead: "create_web_service" },
];

function checkBlockedRoute(method, path) {
  const normalizedPath = ("/" + (path || "").trim()).replace(/\/+/g, "/").split("?")[0];
  for (const rule of BLOCKED_GENERIC_ROUTES) {
    if (rule.method === method.toUpperCase() && rule.pattern.test(normalizedPath)) {
      return rule.useInstead;
    }
  }
  return null;
}

function createServer() {
  const server = new McpServer({
    name: "render-mcp-server",
    version: "1.3.0",
  });

  server.tool(
    "list_services",
    "Liste tous les services (web services, static sites, etc.) du compte Render",
    {
      limit: z.number().optional().describe("Nombre max de résultats (défaut 20)"),
    },
    async ({ limit }) => {
      const data = await renderRequest(`/services?limit=${limit ?? 20}`);
      return toContent(data);
    }
  );

  server.tool(
    "create_web_service",
    "Crée et héberge un nouveau service web Render à partir d'un dépôt GitHub. " +
      "C'est l'outil OBLIGATOIRE pour créer un service — render_api refuse cette action et redirige ici. " +
      "L'ownerId du compte est déjà pré-rempli, pas besoin de le chercher.",
    {
      name: z.string().describe("Nom du service (visible dans le dashboard Render et dans l'URL)"),
      repo: z.string().describe("URL complète du dépôt GitHub, ex: https://github.com/owner/repo"),
      branch: z.string().optional().default("main").describe("Branche à déployer"),
      runtime: z
        .enum(["docker", "node", "python", "ruby", "go", "rust", "static"])
        .optional()
        .default("docker")
        .describe("Type de runtime. 'docker' si le repo contient un Dockerfile."),
      plan: z.enum(["free", "starter", "standard", "pro"]).optional().default("free"),
      region: z.string().optional().default("oregon"),
      buildCommand: z.string().optional().describe("Requis seulement si runtime != docker"),
      startCommand: z.string().optional().describe("Requis seulement si runtime != docker"),
      envVars: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .optional()
        .describe("Variables d'environnement à définir dès la création"),
    },
    async ({ name, repo, branch, runtime, plan, region, buildCommand, startCommand, envVars }) => {
      const body = {
        type: "web_service",
        name,
        ownerId: DEFAULT_OWNER_ID,
        repo,
        branch: branch || "main",
        autoDeploy: "yes",
        serviceDetails: {
          env: runtime || "docker",
          plan: plan || "free",
          region: region || "oregon",
          ...(runtime && runtime !== "docker"
            ? { envSpecificDetails: { buildCommand: buildCommand || "", startCommand: startCommand || "" } }
            : {}),
        },
        ...(envVars && envVars.length ? { envVars } : {}),
      };
      const data = await renderRequest(`/services`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return toContent(data);
    }
  );

  server.tool(
    "get_service",
    "Récupère les détails d'un service Render précis",
    {
      serviceId: z.string().describe("L'ID du service, ex: srv-xxxxxxxx"),
    },
    async ({ serviceId }) => {
      const data = await renderRequest(`/services/${serviceId}`);
      return toContent(data);
    }
  );

  server.tool(
    "list_deploys",
    "Liste les déploiements récents d'un service",
    {
      serviceId: z.string(),
      limit: z.number().optional(),
    },
    async ({ serviceId, limit }) => {
      const data = await renderRequest(
        `/services/${serviceId}/deploys?limit=${limit ?? 10}`
      );
      return toContent(data);
    }
  );

  server.tool(
    "trigger_deploy",
    "Déclenche un nouveau déploiement pour un service",
    {
      serviceId: z.string(),
      clearCache: z.boolean().optional().describe("Vider le cache de build"),
    },
    async ({ serviceId, clearCache }) => {
      const data = await renderRequest(`/services/${serviceId}/deploys`, {
        method: "POST",
        body: JSON.stringify({
          clearCache: clearCache ? "clear" : "do_not_clear",
        }),
      });
      return toContent(data);
    }
  );

  server.tool(
    "list_env_vars",
    "Liste les variables d'environnement d'un service",
    {
      serviceId: z.string(),
    },
    async ({ serviceId }) => {
      const data = await renderRequest(`/services/${serviceId}/env-vars`);
      return toContent(data);
    }
  );

  server.tool(
    "update_env_vars",
    "Remplace toutes les variables d'environnement d'un service",
    {
      serviceId: z.string(),
      envVars: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .describe("Liste complète des variables (remplace l'existant)"),
    },
    async ({ serviceId, envVars }) => {
      const data = await renderRequest(`/services/${serviceId}/env-vars`, {
        method: "PUT",
        body: JSON.stringify(envVars),
      });
      return toContent(data);
    }
  );

  server.tool(
    "list_postgres",
    "Liste les bases de données Postgres du compte",
    {},
    async () => {
      const data = await renderRequest(`/postgres`);
      return toContent(data);
    }
  );

  server.tool(
    "list_logs",
    "Récupère les logs récents d'un service (dernières 100 lignes)",
    {
      serviceId: z.string(),
    },
    async ({ serviceId }) => {
      const data = await renderRequest(
        `/logs?resource=${serviceId}&limit=100`
      );
      return toContent(data);
    }
  );

  // Outil générique : accès à TOUTE l'API Render (v1), pour ne pas être limité
  // aux outils dédiés — SAUF pour les actions qui ont un outil dédié plus fiable
  // (voir BLOCKED_GENERIC_ROUTES), où il refuse et redirige.
  server.tool(
    "render_api",
    "Appelle n'importe quel endpoint de l'API Render v1 directement (GET/POST/PATCH/PUT/DELETE). " +
      "Référence complète des endpoints : https://api-docs.render.com. " +
      "Utilise cet outil pour TOUT ce qui n'est pas déjà couvert par un outil dédié : " +
      "supprimer des services, bases Postgres, Key Value, cron jobs, sites statiques, " +
      "domaines personnalisés, disques, jobs ponctuels, headers/routes, membres du workspace, etc. " +
      "ATTENTION : créer un web service (POST /services) est BLOQUÉ ici — utilise create_web_service à la place.",
    {
      method: z
        .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
        .describe("Méthode HTTP"),
      path: z
        .string()
        .describe(
          "Chemin de l'endpoint après /v1, ex: '/services', '/postgres', '/services/srv-xxx/jobs'"
        ),
      body: z
        .any()
        .optional()
        .describe("Corps JSON de la requête (pour POST/PATCH/PUT)"),
    },
    async ({ method, path, body }) => {
      const useInstead = checkBlockedRoute(method, path);
      if (useInstead) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Action bloquée : la création de service via render_api n'est pas autorisée. Utilise l'outil dédié "${useInstead}" à la place (il gère déjà l'ownerId et la structure correcte).`,
            },
          ],
        };
      }
      const data = await renderRequest(path, {
        method,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return toContent(data);
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// ---- Page d'autorisation ----
// Accessible uniquement avec le lien secret (AUTHORIZE_SECRET).
// Le propriétaire l'ouvre, clique "Autoriser", un token d'accès est généré
// et affiché une seule fois pour être collé dans la config LibreChat.
app.get("/authorize/:secret", (req, res) => {
  if (!AUTHORIZE_SECRET || req.params.secret !== AUTHORIZE_SECRET) {
    return res.status(404).send("Introuvable.");
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head><meta charset="utf-8"><title>Autoriser l'accès Render</title></head>
    <body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align: center;">
      <h2>Connexion au serveur MCP Render</h2>
      <p>Veux-tu autoriser l'accès à ton compte Render (lecture, déploiements, variables d'environnement, etc.) ?</p>
      <form method="POST" action="/authorize/${encodeURIComponent(req.params.secret)}">
        <button type="submit" style="padding: 12px 24px; font-size: 16px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer;">
          Autoriser
        </button>
      </form>
    </body>
    </html>
  `);
});

app.post("/authorize/:secret", express.urlencoded({ extended: true }), (req, res) => {
  if (!AUTHORIZE_SECRET || req.params.secret !== AUTHORIZE_SECRET) {
    return res.status(404).send("Introuvable.");
  }
  const token = newToken();
  activeTokens.add(token);
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head><meta charset="utf-8"><title>Autorisé</title></head>
    <body style="font-family: sans-serif; max-width: 560px; margin: 60px auto;">
      <h2>✅ Accès autorisé</h2>
      <p>Colle ceci dans la config LibreChat (en-tête <code>Authorization</code> du serveur MCP) :</p>
      <pre style="background:#f3f4f6; padding:12px; border-radius:6px; word-break:break-all;">Bearer ${token}</pre>
      <p style="color:#666; font-size: 14px;">Ce token ne sera plus jamais affiché. S'il est perdu, ré-ouvre ce lien pour en générer un nouveau (l'ancien reste valide sauf redémarrage du service).</p>
    </body>
    </html>
  `);
});

// ---- Vérification d'autorisation pour le MCP ----
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({
      error: "Non autorisé. Ouvre le lien d'autorisation fourni par le propriétaire pour te connecter.",
    });
  }
  next();
}

app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/", (req, res) => {
  res.send("Render MCP server is running. Connecte-toi via POST /mcp (autorisation requise).");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Render MCP server listening on port ${PORT}`);
});
