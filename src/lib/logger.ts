import prisma from "./prisma";

const MAX_BATCH_SIZE = 10;
const FLUSH_INTERVAL_SECONDS = 5;

type LogLevel = "DEBUG" | "INFO" | "ERROR";

type LogEntry = {
    level: LogLevel;
    text: string;
    topic: LogTopic;
    error: string | null;
    stack_trace: string | null;
    data: unknown | null;
    metadata: unknown | null;
    request_url: string | null;
    user_id: number | null;
    date: Date;
};

const MAX_LOG_TEXT_LENGTH = 191;

/**
 * Represents the topic of the log. Different topics have different live timespan.
 */
export type LogTopic = 'audit' | 'informational';

/**
 * Options to append to the log event.
 */
export type LogData = {
    /**
     * The id of the user to link this log event with.
     */
    userId?: number;

    /**
     * The url of the request.
     */
    requestUrl?: string;

    /** 
     * Data to append to the log event 
     */
    data?: any;

    /**
     * Metadata of the log event. For example, request time, http method, cookies, etc.
     */
    metadata?: any;
}

export type AuditAction = 'create'|'delete'|'update';

export class Logger {
    private readonly buffer: LogEntry[] = [];
    private flushing: boolean = false
    static readonly instance: Logger = new Logger();

    private constructor() {
        this.setupTimer();
    }

    /**
     * Logs an audit log event.
     */
    public audit(action: AuditAction, data?: LogData, message?: string): void {
        const logData: LogData = {
            metadata: {
                "audit_action": action,
                ...data?.metadata ?? {},
            },
            ...data ?? {}
        }
        
        this.log('INFO', message ?? '', 'audit', null, null, logData)
    }

    /**
     * Logs an Informational log event.
     */
    public info(message: string, data?: LogData): void {
        this.log('INFO', message, 'informational', null,null, data ?? null)
    }
    
    /**
     * Logs an ERROR log event.
     */
    public error(error: any, message?: string, data?: LogData): void {
        this.log('ERROR', message ?? '', 'informational', error, null, data ?? null);
    }

    private log(level: LogLevel, message: string, topic: LogTopic, error: any|null, stackTrace: any|null, data: LogData|null): void {
        const now = new Date()
        const errorText = error?.toString() ?? null;
        const stackTraceText = stackTrace?.toString() ?? null;
        this.buffer.push({
            level: level,
            text: message,
            topic: topic,
            error: errorText ? errorText.slice(0, MAX_LOG_TEXT_LENGTH) : null,
            stack_trace: stackTraceText ? stackTraceText.slice(0, MAX_LOG_TEXT_LENGTH) : null,
            data: data?.data,
            metadata: data?.metadata,
            request_url: data?.requestUrl ?? null,
            user_id: data?.userId ?? null,
            date: now
        });

        if(level === 'ERROR') {
            console.debug(`[${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}] [${level}] [${topic}]: ${message}${error ? ` -> (${error})` : ''}`);
        }
        if(this.buffer.length >= MAX_BATCH_SIZE) {
            this.flushBuffer();
        }
    }

    private async flushBuffer(): Promise<void> {
        if(this.flushing || this.buffer.length === 0) {
            return;
        }

        this.flushing = true;

        // log creation should not break code execution
        try {
            await Promise.all(
                this.buffer.map((logEntry) =>
                    prisma.$executeRawUnsafe(
                        "INSERT INTO logs (topic, level, date, text, user_id, request_url, data, error, stack_trace, metadata) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON))",
                        logEntry.topic,
                        logEntry.level,
                        logEntry.date,
                        logEntry.text,
                        logEntry.user_id,
                        logEntry.request_url,
                        logEntry.data === null ? null : JSON.stringify(logEntry.data),
                        logEntry.error,
                        logEntry.stack_trace,
                        logEntry.metadata === null ? null : JSON.stringify(logEntry.metadata),
                    ),
                ),
            )
            console.debug(`${this.buffer.length} logs flushed`)
        } catch(err) {
            console.error("Log creation failed.", err)
        } finally {
            this.buffer.length = 0;
            this.flushing = false;
        }
    }

    private setupTimer(): void {
        if(!(global as any).isTimerReady) {
            setInterval(() => this.flushBuffer(), FLUSH_INTERVAL_SECONDS*1000);
            (global as any).isTimerReady = true;
        }
    }
}

export const logger = Logger.instance;