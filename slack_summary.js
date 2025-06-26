#!/usr/bin/env node

const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");

// Configuration
const HOURS_TO_FETCH = process.env.HOURS || 24; // Default to last 24 hours
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// Helper function to spawn MCP server and send commands
function callMCPServer(method, params) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
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
    mcp.stderr.on("data", () => {});

    // Handle process exit
    mcp.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}`));
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
    return messages;
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

// Main function
async function main() {
  console.log(
    `Fetching Slack messages from the last ${HOURS_TO_FETCH} hours...\n`
  );

  let fullSummary = `# Slack Summary - Last ${HOURS_TO_FETCH} Hours\n`;
  fullSummary += `Generated at: ${new Date().toLocaleString()}\n`;

  // Process channels sequentially
  for (const channel of CHANNELS) {
    const messages = await fetchChannelMessages(
      channel.id,
      channel.name,
      HOURS_TO_FETCH
    );
    const summary = await summarizeMessages(channel.name, messages);
    fullSummary += summary;
  }

  // Save summary to file
  const filename = `slack_summary_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.md`;
  fs.writeFileSync(filename, fullSummary);

  console.log(`\nSummary saved to: ${filename}`);
  console.log("\n--- SUMMARY PREVIEW ---");
  console.log(fullSummary.substring(0, 1000) + "...");
}

// Run the script
main().catch(console.error);
