#!/usr/bin/env node

const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");

// Load environment variables from .env file if it exists
if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  const lines = envContent.split("\n");

  lines.forEach((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith("#")) {
      const [key, ...valueParts] = trimmedLine.split("=");
      const value = valueParts.join("=").replace(/^["']|["']$/g, ""); // Remove quotes
      if (key && value) {
        process.env[key] = value;
      }
    }
  });

  console.log("Loaded environment variables from .env file");
}

// Configuration
const HOURS_TO_FETCH = process.env.HOURS || 24; // Default to last 24 hours
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is not set!");
  console.error("Please set it in your .env file or export it in your shell.");
  process.exit(1);
}

// Channels to fetch - using IDs from the cache
const CHANNELS = [
  { id: "C072VKHNPH6", name: "new-leads" },
  { id: "C0716U37E1E", name: "ext-told-getmorereviews" },
  { id: "C07183GM4LU", name: "sales" },
  { id: "C091AFEQN7L", name: "marketing" },
  { id: "C08TNLUTGNT", name: "mpdm-jamie--travisse267--bousse-1" },
  { id: "C0934F7HETT", name: "mpdm-travisse267--swaleheenj--jamie--bousse-1" },
  { id: "C08SF9JGKJB", name: "mpdm-travisse267--jamie--henry-1" },
  { id: "D08PFS2J1TJ", name: "DM with Jamie" },
];

// Helper function to parse CSV messages
function parseCSVMessages(csvData) {
  const lines = csvData.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return [];

  const messages = [];

  // Skip header line and process each message line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Parse CSV line properly handling quoted fields
    const parts = [];
    let current = "";
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];

      if (char === '"' && (j === 0 || line[j - 1] === ",")) {
        inQuotes = true;
      } else if (
        char === '"' &&
        inQuotes &&
        (j === line.length - 1 || line[j + 1] === ",")
      ) {
        inQuotes = false;
      } else if (char === "," && !inQuotes) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    parts.push(current); // Add the last part

    // Map to message object
    if (parts.length >= 7) {
      const message = {
        UserID: parts[0] || "",
        UserName: parts[1] || "",
        RealName: parts[2] || "",
        Channel: parts[3] || "",
        ThreadTs: parts[4] || "",
        Text: parts[5] || "",
        Time: parts[6] || "",
        Cursor: parts[7] || "",
      };

      if (message.UserID && message.UserID !== "UserID") {
        // Skip header if present
        messages.push(message);
      }
    }
  }

  return messages;
}

// Helper function to call OpenAI API
function callOpenAI(messages) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are an expert at summarizing Slack conversations. Analyze the messages and provide:
1. A concise executive summary of key discussions and decisions
2. Important action items or todos mentioned
3. Key questions that were asked (and whether they were answered)
4. Notable updates or announcements
5. Any concerns or issues raised

Format your response in clear markdown with appropriate headers.`;

    // Ensure proper JSON encoding of messages
    const cleanMessages = messages.slice(0, 50).map((msg) => ({
      ...msg,
      text: msg.text
        ? msg.text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
        : msg.text,
    }));

    const userPrompt = `Please summarize these Slack messages from the last ${HOURS_TO_FETCH} hours:\n\n${JSON.stringify(
      cleanMessages,
      null,
      2
    )}`;

    const data = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": data.length,
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          const response = JSON.parse(responseData);
          if (response.choices && response.choices[0]) {
            resolve(response.choices[0].message.content);
          } else if (response.error) {
            reject(new Error(response.error.message));
          } else {
            reject(new Error("Unexpected response from OpenAI"));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    req.write(data);
    req.end();
  });
}

// Generic helper to call OpenAI with arbitrary prompts
function callOpenAIChat(systemContent, userContent) {
  return new Promise((resolve, reject) => {
    // Create the request payload
    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    };

    // Convert to JSON string
    const data = JSON.stringify(payload);

    // Create request options
    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          const response = JSON.parse(responseData);
          if (response.choices && response.choices[0]) {
            resolve(response.choices[0].message.content);
          } else if (response.error) {
            reject(new Error(response.error.message));
          } else {
            reject(new Error("Unexpected response from OpenAI"));
          }
        } catch (e) {
          console.error("Failed to parse OpenAI response:", responseData);
          reject(e);
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    req.write(data);
    req.end();
  });
}

// Helper function to spawn MCP server and send commands
function callMCPServer(method, params) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      // Explicitly pass Slack authentication tokens
      SLACK_MCP_XOXC_TOKEN: process.env.SLACK_MCP_XOXC_TOKEN,
      SLACK_MCP_XOXD_TOKEN: process.env.SLACK_MCP_XOXD_TOKEN,
      SLACK_MCP_XOXP_TOKEN: process.env.SLACK_MCP_XOXP_TOKEN,
    };

    const mcp = spawn(
      "npx",
      ["slack-mcp-server@latest", "--transport", "stdio"],
      { env, stdio: ["pipe", "pipe", "pipe"] }
    );

    let buffer = "";
    let initialized = false;
    let requestSent = false;

    // Set a timeout
    const timeout = setTimeout(() => {
      mcp.kill();
      reject(new Error("Timeout"));
    }, 30000); // 30 second timeout

    // Collect stderr for debugging
    let stderrBuffer = "";

    // Handle stdout data
    mcp.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line);

          if (
            !initialized &&
            json.jsonrpc &&
            json.result &&
            json.result.protocolVersion
          ) {
            initialized = true;

            if (!requestSent) {
              requestSent = true;
              // Send our request
              const request = {
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                  name: method,
                  arguments: params,
                },
                id: 2,
              };

              mcp.stdin.write(JSON.stringify(request) + "\n");
            }
          } else if (json.id === 2 && json.result) {
            clearTimeout(timeout);

            // Parse the CSV response
            if (
              json.result.content &&
              json.result.content[0] &&
              json.result.content[0].text
            ) {
              const csvData = json.result.content[0].text;
              const messages = parseCSVMessages(csvData);
              resolve(messages);
            } else {
              resolve([]);
            }

            mcp.kill();
          } else if (json.error) {
            clearTimeout(timeout);
            reject(new Error(json.error.message || "Unknown error"));
            mcp.kill();
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    });

    // Handle stderr (suppress output)
    mcp.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    // Handle process exit
    mcp.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`Process exited with code ${code}. Stderr: ${stderrBuffer}`)
        );
      }
    });

    // Send initialization
    const initRequest = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "0.1.0",
        capabilities: {},
      },
      id: 1,
    };

    mcp.stdin.write(JSON.stringify(initRequest) + "\n");
  });
}

// Function to fetch messages from a channel
async function fetchChannelMessages(channelId, channelName, hoursAgo) {
  const oldest = Math.floor((Date.now() - hoursAgo * 60 * 60 * 1000) / 1000);

  console.log(
    `Fetching messages from ${channelName} (${channelId}) for the last ${hoursAgo} hours...`
  );

  try {
    const messages = await callMCPServer("conversations_history", {
      channel_id: channelId,
      oldest: oldest.toString(),
      limit: "200",
      include_activity_messages: false,
    });

    console.log(`  Found ${messages.length} messages`);

    // Filter messages within the timeframe (safety check)
    const oldestMs = Date.now() - hoursAgo * 60 * 60 * 1000;
    const filtered = messages.filter((m) => {
      if (!m.Time) return false;
      const tsMs = parseFloat(m.Time) * 1000; // Slack timestamps are in seconds
      return tsMs >= oldestMs;
    });

    if (filtered.length !== messages.length) {
      console.log(
        `  Filtered to ${filtered.length} messages after timeframe check`
      );
    }
    return filtered;
  } catch (error) {
    console.error(`  Error: ${error.message}`);
    return [];
  }
}

// Function to format and summarize messages
async function summarizeMessages(channelName, messages) {
  if (!messages || messages.length === 0) {
    return `\n## ${channelName}\nNo messages in the last ${HOURS_TO_FETCH} hours.\n`;
  }

  let summary = `\n## ${channelName}\n`;
  summary += `Total messages: ${messages.length}\n\n`;

  // Prepare messages for AI summarization
  const formattedMessages = messages.map((msg) => {
    let timestamp = "Unknown time";
    if (msg.Time && msg.Time.match(/^\d{10}\.\d+$/)) {
      timestamp = new Date(parseFloat(msg.Time) * 1000).toLocaleString();
    }

    return {
      time: timestamp,
      user: msg.RealName || msg.UserName || msg.UserID,
      text: msg.Text || "[No text]",
      thread: msg.ThreadTs || null,
    };
  });

  try {
    console.log(`  Generating AI summary for ${channelName}...`);
    const aiSummary = await callOpenAI(formattedMessages);
    summary += "### AI-Generated Summary:\n";
    summary += aiSummary + "\n\n";
  } catch (error) {
    console.error(`  Error generating AI summary: ${error.message}`);
    summary += "### Summary Generation Error\n";
    summary += `Could not generate AI summary: ${error.message}\n\n`;

    // Fallback to basic summary
    summary += "### Recent Messages:\n";
    messages.slice(0, 5).forEach((msg) => {
      let timestamp = "Unknown time";
      if (msg.Time && msg.Time.match(/^\d{10}\.\d+$/)) {
        timestamp = new Date(parseFloat(msg.Time) * 1000).toLocaleString();
      }
      const userName = msg.RealName || msg.UserName || msg.UserID;
      const text = msg.Text
        ? msg.Text.substring(0, 100) + (msg.Text.length > 100 ? "..." : "")
        : "[No text]";
      summary += `- [${timestamp}] ${userName}: ${text}\n`;
    });
  }

  // Still include user activity stats
  const messagesByUser = {};
  messages.forEach((msg) => {
    const userName = msg.RealName || msg.UserName || msg.UserID;
    if (!messagesByUser[userName]) {
      messagesByUser[userName] = [];
    }
    messagesByUser[userName].push(msg);
  });

  summary += "\n### User Activity Stats:\n";
  Object.entries(messagesByUser)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .forEach(([user, userMessages]) => {
      summary += `- ${user}: ${userMessages.length} messages\n`;
    });

  return summary;
}

// Generate the overall summary, action items, and per-channel summaries
async function generateOverallSummary(channelsData, hours) {
  // Create a simple text summary of all messages
  let allMessages = [];

  channelsData.forEach((channel) => {
    if (channel.messages.length > 0) {
      channel.messages.slice(0, 20).forEach((msg) => {
        const user = msg.RealName || msg.UserName || msg.UserID || "Unknown";
        const text = (msg.Text || "")
          .replace(/[^\x20-\x7E]/g, " ") // Replace non-printable with space
          .replace(/\s+/g, " ") // Normalize whitespace
          .trim()
          .substring(0, 100);

        if (text) {
          allMessages.push(`[${channel.name}] ${user}: ${text}`);
        }
      });
    }
  });

  const systemPrompt = `You are a Slack conversation summarizer. Analyze the messages and create a markdown summary with exactly these three sections:

# Overall Summary
Write a concise summary (max 6 sentences) of what happened across all channels in the last ${hours} hours.

## Action Items
List clear, actionable tasks mentioned in the conversations (max 10 bullets).

## Channel Summaries
For each active channel, write:
### {channel_name}
- 3–5 bullet points summarizing that channel's discussion. When a message itself contains a summary or notes (e.g. "Alexis Mintz summarized …", "Bousse shared notes …"), include the key take-aways of that embedded summary in the same bullet, e.g. "Alexis Mintz summarized the dev call – main points: API contract finalised; frontend deadline moved to Friday".
- Prefer specific details over generic statements.
- Keep each bullet brief (≤ 25 words).

Keep the whole markdown concise and focused.`;

  const userPrompt = `Here are the recent Slack messages:\n\n${allMessages.join(
    "\n"
  )}`;

  console.log("  Generating overall summary...");
  return await callOpenAIChat(systemPrompt, userPrompt);
}

// Main function
async function main() {
  console.log(
    `Fetching Slack messages from the last ${HOURS_TO_FETCH} hours...\n`
  );

  const channelData = [];
  for (const channel of CHANNELS) {
    const messages = await fetchChannelMessages(
      channel.id,
      channel.name,
      HOURS_TO_FETCH
    );
    channelData.push({ name: channel.name, messages });
  }

  const overallMarkdown = await generateOverallSummary(
    channelData,
    HOURS_TO_FETCH
  );

  // Save summary to file
  const now = new Date();
  const dateStr = now
    .toLocaleDateString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, "-");
  const timeStr = now
    .toLocaleTimeString("en-US", {
      hour12: true,
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(/:/g, "-")
    .replace(/\s/g, "");

  const filename = `slack_summary_${dateStr}_${timeStr}.md`;
  fs.writeFileSync(filename, overallMarkdown);

  console.log(`\nSummary saved to: ${filename}`);
  console.log("\n--- SUMMARY PREVIEW ---");
  console.log(overallMarkdown.substring(0, 1000) + "...");
}

// Run the script
main().catch(console.error);
