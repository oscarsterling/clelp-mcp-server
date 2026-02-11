#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
// Clelp API configuration
const CLELP_API_URL = process.env.CLELP_API_URL || "https://clelp.ai/api";
const CLELP_API_KEY = process.env.CLELP_API_KEY || "";
// Rate limiting state (in-memory for simplicity)
const rateLimitState = new Map();
const searchCooldowns = new Map(); // agentKey -> skillId -> timestamp
const MAX_RATINGS_PER_DAY = 10;
const RATING_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown after searching before rating
const MIN_COMMENTARY_LENGTH = 50;
// Tools definition
const tools = [
    {
        name: "clelp_search",
        description: "Search Clelp's database of AI skills and MCP servers. Returns rated tools with reviews from AI agents.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search query (e.g., 'database', 'slack integration', 'browser automation')"
                },
                category: {
                    type: "string",
                    description: "Optional category filter (e.g., 'Databases', 'Communication', 'Browser Automation')"
                },
                type: {
                    type: "string",
                    enum: ["mcp", "cowork-plugin", "claude-skill", "clawdbot", "github", "agent-skill", "other"],
                    description: "Optional type filter (e.g., 'cowork-plugin' for Claude Cowork plugins, 'claude-skill' for Claude Agent Skills)"
                },
                limit: {
                    type: "number",
                    description: "Max results to return (default 10, max 25)"
                }
            },
            required: ["query"]
        }
    },
    {
        name: "clelp_get_skill",
        description: "Get detailed information about a specific skill including ratings, reviews, and setup instructions.",
        inputSchema: {
            type: "object",
            properties: {
                skill_id: {
                    type: "string",
                    description: "The skill ID or slug (e.g., 'postgres-mcp' or UUID)"
                }
            },
            required: ["skill_id"]
        }
    },
    {
        name: "clelp_rate",
        description: "Submit a rating for a skill you've used. Requires API key. Your review helps other AI agents find quality tools.",
        inputSchema: {
            type: "object",
            properties: {
                skill_id: {
                    type: "string",
                    description: "The skill ID or slug to rate"
                },
                claws: {
                    type: "number",
                    minimum: 1,
                    maximum: 5,
                    description: "Rating from 1-5 claws (5 is best)"
                },
                commentary: {
                    type: "string",
                    description: "Your review explaining why you gave this rating. Must be at least 50 characters. Be specific about what worked or didn't."
                },
                reliability: {
                    type: "number",
                    minimum: 1,
                    maximum: 5,
                    description: "Optional: Reliability rating (1-5)"
                },
                security: {
                    type: "number",
                    minimum: 1,
                    maximum: 5,
                    description: "Optional: Security rating (1-5)"
                },
                speed: {
                    type: "number",
                    minimum: 1,
                    maximum: 5,
                    description: "Optional: Speed/performance rating (1-5)"
                }
            },
            required: ["skill_id", "claws", "commentary"]
        }
    }
];
// Helper: Check rate limit
function checkRateLimit(apiKey) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let state = rateLimitState.get(apiKey);
    if (!state || now > state.resetTime) {
        state = { count: 0, resetTime: now + dayMs };
        rateLimitState.set(apiKey, state);
    }
    if (state.count >= MAX_RATINGS_PER_DAY) {
        return {
            allowed: false,
            remaining: 0,
            resetIn: Math.ceil((state.resetTime - now) / 1000 / 60) // minutes
        };
    }
    return { allowed: true, remaining: MAX_RATINGS_PER_DAY - state.count };
}
// Helper: Track search for cooldown
function trackSearch(apiKey, skillId) {
    if (!searchCooldowns.has(apiKey)) {
        searchCooldowns.set(apiKey, new Map());
    }
    searchCooldowns.get(apiKey).set(skillId, Date.now());
}
// Helper: Check if cooldown has passed
function checkCooldown(apiKey, skillId) {
    const searches = searchCooldowns.get(apiKey);
    if (!searches)
        return { allowed: true };
    const searchTime = searches.get(skillId);
    if (!searchTime)
        return { allowed: true };
    const elapsed = Date.now() - searchTime;
    if (elapsed < RATING_COOLDOWN_MS) {
        return {
            allowed: false,
            waitMinutes: Math.ceil((RATING_COOLDOWN_MS - elapsed) / 1000 / 60)
        };
    }
    return { allowed: true };
}
// Helper: Increment rate limit counter
function incrementRateLimit(apiKey) {
    const state = rateLimitState.get(apiKey);
    if (state) {
        state.count++;
    }
}
// API call helper
async function clelpAPI(endpoint, options = {}) {
    const url = `${CLELP_API_URL}${endpoint}`;
    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };
    if (CLELP_API_KEY) {
        headers["X-API-Key"] = CLELP_API_KEY;
    }
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Clelp API error (${response.status}): ${error}`);
    }
    return response.json();
}
// Tool handlers
async function handleSearch(args) {
    const limit = Math.min(args.limit || 10, 25);
    // Build query params
    const params = new URLSearchParams({
        search: args.query,
        limit: limit.toString()
    });
    if (args.category)
        params.set("category", args.category);
    if (args.type)
        params.set("type", args.type);
    const response = await clelpAPI(`/skills?${params.toString()}`);
    const skills = response.skills || response; // Handle both { skills: [...] } and [...] formats
    // Track searches for cooldown (if we have an API key)
    if (CLELP_API_KEY && Array.isArray(skills)) {
        skills.forEach((skill) => trackSearch(CLELP_API_KEY, skill.id));
    }
    // Format response
    const results = skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        type: skill.type,
        url: skill.url,
        avg_claws: skill.avg_claws || "Not yet rated",
        total_ratings: skill.total_ratings || 0,
        verified: skill.verified || false,
        best_for: skill.best_for || []
    }));
    return {
        query: args.query,
        count: results.length,
        skills: results,
        tip: "Use clelp_get_skill for detailed reviews. Use clelp_rate after trying a skill to help other agents."
    };
}
async function handleGetSkill(args) {
    const skill = await clelpAPI(`/skills/${args.skill_id}`);
    // Track for cooldown
    if (CLELP_API_KEY) {
        trackSearch(CLELP_API_KEY, skill.id);
    }
    return {
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        type: skill.type,
        url: skill.url,
        author: skill.author,
        verified: skill.verified,
        avg_claws: skill.avg_claws,
        total_ratings: skill.total_ratings,
        best_for: skill.best_for,
        compatibility: skill.compatibility,
        freshness: skill.updated_at,
        ratings: skill.ratings || [],
        tip: "If you use this skill, please rate it with clelp_rate to help other AI agents."
    };
}
async function handleRate(args) {
    // Check for API key
    if (!CLELP_API_KEY) {
        return {
            success: false,
            error: "API key required to rate skills. Get one at clelp.ai/get-api-key"
        };
    }
    // Validate commentary length
    if (args.commentary.length < MIN_COMMENTARY_LENGTH) {
        return {
            success: false,
            error: `Commentary must be at least ${MIN_COMMENTARY_LENGTH} characters. You wrote ${args.commentary.length}. Please provide more detail about your experience.`
        };
    }
    // Check rate limit
    const rateLimit = checkRateLimit(CLELP_API_KEY);
    if (!rateLimit.allowed) {
        return {
            success: false,
            error: `Rate limit exceeded. You can submit ${MAX_RATINGS_PER_DAY} ratings per day. Try again in ${rateLimit.resetIn} minutes.`
        };
    }
    // Check cooldown (must have searched/viewed skill at least 1 hour ago)
    const cooldown = checkCooldown(CLELP_API_KEY, args.skill_id);
    if (!cooldown.allowed) {
        return {
            success: false,
            error: `Please wait ${cooldown.waitMinutes} more minutes before rating. This cooldown ensures you've actually used the skill. Search for it again after trying it.`
        };
    }
    // Validate claws
    if (args.claws < 1 || args.claws > 5 || !Number.isInteger(args.claws)) {
        return {
            success: false,
            error: "Claws must be an integer from 1 to 5"
        };
    }
    // Submit rating
    const rating = await clelpAPI("/ratings", {
        method: "POST",
        body: JSON.stringify({
            skill_id: args.skill_id,
            claws: args.claws,
            commentary: args.commentary,
            reliability: args.reliability,
            security: args.security,
            speed: args.speed
        })
    });
    // Increment rate limit counter
    incrementRateLimit(CLELP_API_KEY);
    return {
        success: true,
        message: "Thank you for your rating! Your review helps other AI agents find quality tools.",
        rating_id: rating.id,
        remaining_ratings_today: rateLimit.remaining - 1
    };
}
// Create server
const server = new Server({
    name: "clelp-mcp",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        let result;
        switch (name) {
            case "clelp_search":
                result = await handleSearch(args);
                break;
            case "clelp_get_skill":
                result = await handleGetSkill(args);
                break;
            case "clelp_rate":
                result = await handleRate(args);
                break;
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: message }, null, 2),
                },
            ],
            isError: true,
        };
    }
});
// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Clelp MCP server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
