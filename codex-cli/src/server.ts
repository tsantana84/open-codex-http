import type { ApprovalPolicy } from "./approvals.js";
import type { CommandConfirmation } from "./utils/agent/agent-loop.js";
import type { AppConfig } from "./utils/config.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";

import { AgentLoop } from "./utils/agent/agent-loop.js";
import { ReviewDecision } from "./utils/agent/review.js";
import { AutoApprovalMode } from "./utils/auto-approval-mode.js";
import { createInputItem } from "./utils/input-utils.js";
import { randomUUID } from "node:crypto";

// Error types for better error handling
class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = "ValidationError";
  }
}

class SessionError extends Error {
  constructor(message: string, public sessionId?: string) {
    super(message);
    this.name = "SessionError";
  }
}

class AgentError extends Error {
  constructor(message: string, public originalError?: Error) {
    super(message);
    this.name = "AgentError";
  }
}

type ServerConfig = {
  port: number;
  host: string;
  config: AppConfig;
};

type ChatRequest = {
  prompt: string;
  imagePaths?: Array<string>;
  approvalMode?: "suggest" | "auto-edit" | "full-auto"; // Note: HTTP mode forces read-only
  sessionId?: string;
};

type ChatResponse = {
  sessionId: string;
  messages: Array<ChatCompletionMessageParam>;
  status: "completed" | "error";
  error?: string;
};

// Store active sessions and their conversation history
const activeSessions = new Map<string, AgentLoop>();
const sessionHistory = new Map<string, Array<ChatCompletionMessageParam>>(); // Complete conversation history

// Define read-only tool functions (tools that only read, don't modify)
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob", 
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoRead"
]);

// Tools that modify files or execute commands (blocked in HTTP mode)
const WRITE_TOOLS = new Set([
  "Edit",
  "MultiEdit", 
  "Write",
  "NotebookEdit",
  "Bash",
  "TodoWrite",
  "Task"
]);

function isReadOnlyToolCall(toolCall: any): boolean {
  const functionName = toolCall?.function?.name;
  return READ_ONLY_TOOLS.has(functionName);
}

function isWriteToolCall(toolCall: any): boolean {
  const functionName = toolCall?.function?.name;
  return WRITE_TOOLS.has(functionName);
}

function filterMessageForReadOnly(item: ChatCompletionMessageParam): ChatCompletionMessageParam | null {
  // If it's an assistant message with tool calls, filter out write operations
  if (item.role === "assistant" && "tool_calls" in item && item.tool_calls) {
    const writeToolCalls = item.tool_calls.filter(isWriteToolCall);
    const readToolCalls = item.tool_calls.filter(isReadOnlyToolCall);
    
    // If there are write tool calls, replace with a friendly message
    if (writeToolCalls.length > 0) {
      const writeOperations = writeToolCalls.map(tc => tc.function.name).join(", ");
      const friendlyMessage = `I can see you'd like me to perform write operations (${writeOperations}), but I'm running in read-only mode via HTTP. I can help you understand your codebase, analyze files, search for patterns, and answer questions, but I cannot modify files or execute commands.\n\nWould you like me to help you explore or analyze your code instead?`;
      
      // If there are also read operations, keep those and add the message
      if (readToolCalls.length > 0) {
        return {
          ...item,
          tool_calls: readToolCalls,
          content: (typeof item.content === "string" ? item.content + "\n\n" : "") + friendlyMessage
        };
      } else {
        // Only write operations - replace with friendly message
        return {
          ...item,
          tool_calls: undefined,
          content: friendlyMessage
        };
      }
    }
  }
  
  // For tool responses from write operations, don't include them
  if (item.role === "tool" && "tool_call_id" in item) {
    // We can't easily determine if this was from a write tool without more context
    // So we'll let tool responses through, but they shouldn't happen since we filter the calls
    return item;
  }
  
  // Pass through all other messages unchanged
  return item;
}

// Validation functions
function validateChatRequest(body: any): ChatRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError("Request body must be a JSON object");
  }

  if (!body.prompt || typeof body.prompt !== 'string') {
    throw new ValidationError("'prompt' field is required and must be a string", "prompt");
  }

  if (body.prompt.trim().length === 0) {
    throw new ValidationError("'prompt' cannot be empty", "prompt");
  }

  if (body.prompt.length > 10000) {
    throw new ValidationError("'prompt' is too long (max 10000 characters)", "prompt");
  }

  if (body.sessionId && typeof body.sessionId !== 'string') {
    throw new ValidationError("'sessionId' must be a string", "sessionId");
  }

  if (body.sessionId && body.sessionId.length > 100) {
    throw new ValidationError("'sessionId' is too long (max 100 characters)", "sessionId");
  }

  if (body.imagePaths && !Array.isArray(body.imagePaths)) {
    throw new ValidationError("'imagePaths' must be an array", "imagePaths");
  }

  if (body.imagePaths && body.imagePaths.length > 10) {
    throw new ValidationError("Too many images (max 10)", "imagePaths");
  }

  return {
    prompt: body.prompt.trim(),
    sessionId: body.sessionId,
    imagePaths: body.imagePaths,
    approvalMode: body.approvalMode
  };
}

// Error response utilities
function sendErrorResponse(
  res: NodeJS.WritableStream & { writeHead: (code: number, headers?: Record<string, string>) => void; end: (data?: string) => void },
  statusCode: number,
  error: string,
  details?: any
) {
  const response = {
    error,
    timestamp: new Date().toISOString(),
    ...(details && { details })
  };

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response, null, 2));
}

function handleError(
  res: NodeJS.WritableStream & { writeHead: (code: number, headers?: Record<string, string>) => void; end: (data?: string) => void },
  error: Error,
  context?: string
) {
  console.error(`❌ ${context || 'Error'}:`, {
    name: error.name,
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });

  if (error instanceof ValidationError) {
    sendErrorResponse(res, 400, error.message, { field: error.field });
  } else if (error instanceof SessionError) {
    sendErrorResponse(res, 404, error.message, { sessionId: error.sessionId });
  } else if (error instanceof AgentError) {
    sendErrorResponse(res, 503, "Service temporarily unavailable", { 
      message: "Agent processing failed", 
      retry: true 
    });
  } else {
    sendErrorResponse(res, 500, "Internal server error");
  }
}

export async function runServer({ port, host, config }: ServerConfig): Promise<void> {
  // Use Node.js built-in HTTP server to avoid external dependencies
  const { createServer } = await import("node:http");
  const { parse } = await import("node:url");
  
  const server = createServer(async (req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = parse(req.url || "", true);
    
    try {
      if (req.method === "POST" && url.pathname === "/chat") {
        await handleChatRequest(req, res, config);
      } else if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          status: "ok", 
          version: "0.1.31",
          timestamp: new Date().toISOString(),
          activeSessions: activeSessions.size
        }));
      } else if (req.method === "DELETE" && url.pathname?.startsWith("/sessions/")) {
        const sessionId = url.pathname.split("/")[2];
        if (!sessionId || sessionId.trim().length === 0) {
          throw new ValidationError("Session ID is required", "sessionId");
        }
        await handleSessionTerminate(res, sessionId.trim());
      } else if (req.method === "GET" && url.pathname === "/sessions") {
        // List active sessions endpoint
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          activeSessions: Array.from(activeSessions.keys()),
          count: activeSessions.size,
          timestamp: new Date().toISOString()
        }));
      } else {
        sendErrorResponse(res, 404, "Endpoint not found", {
          method: req.method,
          path: url.pathname,
          availableEndpoints: [
            "POST /chat",
            "GET /health", 
            "GET /sessions",
            "DELETE /sessions/{sessionId}"
          ]
        });
      }
    } catch (error) {
      handleError(res, error as Error, "Server request");
    }
  });

  // Add request timeouts
  server.timeout = 300000; // 5 minutes
  server.headersTimeout = 60000; // 1 minute
  server.requestTimeout = 300000; // 5 minutes

  // Return a promise that resolves when server starts
  return new Promise<void>((resolve, reject) => {
    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use. Please try a different port.`);
        reject(new Error(`Port ${port} is already in use`));
      } else if (error.code === 'EACCES') {
        console.error(`❌ Permission denied to bind to port ${port}. Try using a port above 1024.`);
        reject(new Error(`Permission denied for port ${port}`));
      } else {
        console.error("❌ Server error:", error);
        reject(error);
      }
    });

    server.listen(port, host, () => {
      console.log(`🚀 Codex HTTP server running at http://${host}:${port}`);
      console.log(`🔒 Note: HTTP mode only allows read operations (file analysis, code exploration)`);
      console.log(`📚 Available endpoints:`);
      console.log(`   POST /chat - Chat with Julia`);
      console.log(`   GET  /health - Health check`);
      console.log(`   GET  /sessions - List active sessions`);
      console.log(`   DELETE /sessions/{id} - Terminate session`);
      resolve();
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });
  });
}

async function handleChatRequest(
  req: NodeJS.ReadableStream,
  res: NodeJS.WritableStream & { writeHead: (code: number, headers?: Record<string, string>) => void; end: (data?: string) => void },
  config: AppConfig
): Promise<void> {
  try {
    // Read and validate request body
    let body = "";
    let chunkCount = 0;
    const maxChunks = 1000; // Prevent DoS attacks
    
    for await (const chunk of req) {
      chunkCount++;
      if (chunkCount > maxChunks) {
        throw new ValidationError("Request body too large");
      }
      body += chunk.toString();
    }

    if (body.length === 0) {
      throw new ValidationError("Request body is empty");
    }

    if (body.length > 50000) {
      throw new ValidationError("Request body too large (max 50KB)");
    }

    // Parse and validate JSON
    let parsedBody: any;
    try {
      parsedBody = JSON.parse(body);
    } catch (parseError) {
      throw new ValidationError("Invalid JSON in request body");
    }

    // Validate chat request
    const chatRequest = validateChatRequest(parsedBody);
    const sessionId = chatRequest.sessionId || randomUUID();
    
    // Validate session ID format if provided
    if (chatRequest.sessionId && !/^[a-zA-Z0-9_-]+$/.test(chatRequest.sessionId)) {
      throw new ValidationError("Session ID contains invalid characters", "sessionId");
    }
    
    // HTTP mode is always read-only - force SUGGEST mode regardless of request
    const approvalPolicy: ApprovalPolicy = AutoApprovalMode.SUGGEST;

    // Get or initialize conversation history for this session
    const prevItems = [...(sessionHistory.get(sessionId) || [])];
    const messageCollector = { messages: [] as Array<ChatCompletionMessageParam> };

    // Check for too many messages in session history
    if (prevItems.length > 1000) {
      throw new SessionError("Session has too many messages (max 1000)", sessionId);
    }

    // Always create a fresh agent for each request to avoid state pollution
    // The existing agent might have stale onItem callbacks or other state issues
    let agent = activeSessions.get(sessionId);
    
    // Terminate existing agent if it exists
    if (agent) {
      agent.terminate();
    }
    
    // Always create a fresh agent
    const readOnlyInstructions = `${config.instructions || ""}

IMPORTANT: You are running in READ-ONLY HTTP mode. You can only:
- Read files (Read, Glob, Grep, LS, NotebookRead)
- Search and analyze code
- Answer questions about the codebase
- Provide explanations and documentation

You CANNOT:
- Edit or write files (Edit, MultiEdit, Write, NotebookEdit)
- Execute commands (Bash)
- Create todos (TodoWrite)
- Perform any modification operations

If the user asks you to modify files or run commands, politely explain that you're in read-only mode and offer to help with code analysis instead.`;

    agent = new AgentLoop({
        model: config.model,
        config: config,
        instructions: readOnlyInstructions,
        approvalPolicy,
        onItem: (item: ChatCompletionMessageParam) => {
          // Filter for HTTP response
          const filteredItem = filterMessageForReadOnly(item);
          if (filteredItem) {
            messageCollector.messages.push(filteredItem);
          }
        },
        onLoading: () => {
          // HTTP doesn't need loading indicators
        },
        getCommandConfirmation: (
          _command: Array<string>,
        ): Promise<CommandConfirmation> => {
          // In HTTP read-only mode, always deny command execution
          return Promise.resolve({ review: ReviewDecision.NO_CONTINUE });
        },
        onReset: () => {
          // Reset handled internally
        },
      });
      
      activeSessions.set(sessionId, agent);

    const inputItem = await createInputItem(
      chatRequest.prompt,
      chatRequest.imagePaths || []
    );
    
    // Call agent.run with new input and previous conversation history
    try {
      await agent.run([inputItem], prevItems);
    } catch (agentError) {
      throw new AgentError("Failed to process chat request", agentError as Error);
    }
    
    // Update session history with all messages from this conversation
    const allMessages = [...prevItems, ...messageCollector.messages];
    sessionHistory.set(sessionId, allMessages);

    // Send successful response
    const response: ChatResponse = {
      sessionId,
      messages: messageCollector.messages,
      status: "completed",
    };
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response, null, 2));

  } catch (error) {
    handleError(res, error as Error, "Chat request");
  }
}

async function handleSessionTerminate(
  res: NodeJS.WritableStream & { writeHead: (code: number, headers?: Record<string, string>) => void; end: (data?: string) => void }, 
  sessionId: string
): Promise<void> {
  try {
    const agent = activeSessions.get(sessionId);
    
    if (agent) {
      try {
        agent.terminate();
      } catch (terminateError) {
        console.error(`⚠️ Error terminating agent for session ${sessionId}:`, terminateError);
        // Continue with cleanup even if termination fails
      }
      
      activeSessions.delete(sessionId);
      sessionHistory.delete(sessionId);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        message: "Session terminated successfully",
        sessionId,
        timestamp: new Date().toISOString()
      }));
    } else {
      throw new SessionError("Session not found", sessionId);
    }
  } catch (error) {
    handleError(res, error as Error, "Session termination");
  }
}