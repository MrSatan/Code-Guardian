import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  JsonOutputParser,
  StringOutputParser,
} from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';

// This is a placeholder for the structured feedback from the AI
export interface AIFeedback {
  file: string;
  line: number;
  comment: string;
  diffHunk?: string; // Git diff hunk context for GitHub API
}

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  private readonly model: ChatGoogleGenerativeAI;
  private readonly maxDiffLinesForChunking: number;
  private readonly maxDiffSizeForChunking: number;
  private readonly maxFileChunkLines: number;
  private readonly maxFileChunkSize: number;
  private readonly maxSubChunkLines: number;
  private readonly parallelBatchSize: number;
  private readonly excludedFilePatterns: string[];
  private readonly chunkMergeEnabled: boolean;
  private readonly optimalChunkSize: number;
  private readonly maxChunkSize: number;
  private readonly minChunkSize: number;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GOOGLE_API_KEY');
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY is not configured.');
    }

    const maxOutputTokens = this.configService.get<number>('ai.maxOutputTokens') || 1500; // Reduced for 10K/min limit
    this.maxDiffLinesForChunking = this.configService.get<number>('ai.maxDiffLinesForChunking') || 300;
    this.maxDiffSizeForChunking = this.configService.get<number>('ai.maxDiffSizeForChunking') || 20000;
    this.maxFileChunkLines = this.configService.get<number>('ai.maxFileChunkLines') || 150;
    this.maxFileChunkSize = this.configService.get<number>('ai.maxFileChunkSize') || 8000;
    this.maxSubChunkLines = this.configService.get<number>('ai.maxSubChunkLines') || 80;
    this.parallelBatchSize = this.configService.get<number>('ai.parallelBatchSize') || 2;
    this.excludedFilePatterns = this.configService.get<string[]>('ai.excludedFilePatterns') || [];
    this.chunkMergeEnabled = this.configService.get<boolean>('ai.chunkMergeEnabled') ?? true;
    this.optimalChunkSize = this.configService.get<number>('ai.optimalChunkSize') || 120;
    this.maxChunkSize = this.configService.get<number>('ai.maxChunkSize') || 200;
    this.minChunkSize = this.configService.get<number>('ai.minChunkSize') || 40;

    this.logger.log(`AI Configuration (10K tokens/min optimized):`);
    this.logger.log(`  - Max output tokens: ${maxOutputTokens} (reduced for rate limit)`);
    this.logger.log(`  - Chunking thresholds: lines=${this.maxDiffLinesForChunking}, size=${this.maxDiffSizeForChunking}`);
    this.logger.log(`  - File chunk limits: lines=${this.maxFileChunkLines}, size=${this.maxFileChunkSize}`);
    this.logger.log(`  - Parallel processing: ${this.parallelBatchSize} concurrent chunks`);
    this.logger.log(`  - Chunk merging: enabled=${this.chunkMergeEnabled}, optimal=${this.optimalChunkSize} lines`);
    this.logger.log(`  - Excluded patterns: ${this.excludedFilePatterns.length} patterns configured`);

    this.model = new ChatGoogleGenerativeAI({
      apiKey,
      model: 'gemini-2.5-flash-lite',
      temperature: 0.7,
      maxOutputTokens,
    });
  }

  async analyzeDiff(
    diff: string,
    customRules: string | null,
  ): Promise<AIFeedback[]> {
    const diffLines = diff.split('\n').length;
    const diffSize = diff.length;
    const rulesSize = customRules?.length || 0;

    this.logger.log(`Analyzing diff with AI...`);
    this.logger.log(`Diff size: ${diffLines} lines (${diffSize} chars)`);
    this.logger.log(`Custom rules size: ${rulesSize} chars`);

    // Check for potentially problematic large diffs
    if (diffLines > 1000) {
      this.logger.warn(`Large diff detected: ${diffLines} lines. This may exceed token limits.`);
    }

    if (diffSize > 50000) {
      this.logger.warn(`Very large diff detected: ${diffSize} characters. Consider chunking or summarizing.`);
    }

    // For very large diffs, try chunking approach
    if (diffLines > this.maxDiffLinesForChunking || diffSize > this.maxDiffSizeForChunking) {
      this.logger.log(`Attempting chunked analysis for large diff...`);
      return this.analyzeDiffInChunks(diff, customRules);
    }

    const parser = new JsonOutputParser<AIFeedback[]>();

    const prompt = new PromptTemplate({
      template: `
        You are an expert code reviewer. Your task is to analyze the following code diff and provide feedback.
        Focus on identifying potential bugs, performance issues, and deviations from best practices.
        Do not comment on code style.
        The output should be a JSON array of objects, where each object has the following format:
        {{
          "file": "path/to/file",
          "line": <line_number>,
          "comment": "Your comment here"
        }}

        Here are the custom rules to follow:
        {rules}

        Here is the code diff:
        {diff}
      `,
      inputVariables: ['diff', 'rules'],
    });

    const chain = prompt.pipe(this.model).pipe(parser);

    try {
      this.logger.log('Invoking AI model...');
      const feedback = await chain.invoke({
        diff,
        rules: customRules || 'No custom rules provided.',
      });

      this.logger.log(`AI analysis complete. Received ${Array.isArray(feedback) ? feedback.length : 'non-array'} feedback items.`);

      if (!Array.isArray(feedback)) {
        this.logger.error(`AI returned non-array response:`, typeof feedback, feedback);
        return [];
      }

      return feedback;
    } catch (error) {
      this.logger.error(`AI analysis failed:`, error.message);
      this.logger.error(`Error details:`, error);

      // Try to extract more information from the error
      if (error.message?.includes('token')) {
        this.logger.error('Token limit likely exceeded for large diff');
      }

      if (error.message?.includes('timeout')) {
        this.logger.error('AI request timed out - possibly due to large diff size');
      }

      // Return empty array instead of throwing to prevent job failure
      return [];
    }
  }

  private async analyzeDiffInChunks(
    diff: string,
    customRules: string | null,
  ): Promise<AIFeedback[]> {
    this.logger.log('Analyzing diff in chunks due to size...');

    const files = this.splitDiffByFiles(diff);
    const allChunks: { content: string; label: string; index: number }[] = [];
    let skippedFiles = 0;

    this.logger.log(`Initial split into ${files.length} file chunks`);

    // First pass: collect all chunks that need processing
    for (let i = 0; i < files.length; i++) {
      const fileDiff = files[i];
      const fileLines = fileDiff.split('\n').length;
      const fileSize = fileDiff.length;

      // Extract filename from the diff chunk
      const fileName = this.extractFileNameFromDiff(fileDiff);

      // Check if this file should be excluded from analysis
      if (fileName && this.shouldExcludeFile(fileName)) {
        this.logger.log(`Skipping excluded file: ${fileName} (${fileLines} lines, ${fileSize} chars)`);
        skippedFiles++;
        continue;
      }

      this.logger.log(`Analyzing file chunk ${i + 1}/${files.length} (${fileLines} lines, ${fileSize} chars) - ${fileName || 'unknown'}`);

      // Smart content-aware sub-chunking decision
      const shouldSubChunk = this.shouldSubChunkFile(fileDiff, fileLines, fileSize, fileName);

      if (shouldSubChunk.needsSubChunking) {
        this.logger.log(`File chunk ${i + 1} needs sub-chunking: ${shouldSubChunk.reason}`);
        const subChunks = this.splitLargeFileIntoSubChunks(fileDiff, shouldSubChunk.chunkSize);

        for (let j = 0; j < subChunks.length; j++) {
          const subChunk = subChunks[j];
          const subLines = subChunk.split('\n').length;
          const subSize = subChunk.length;

          allChunks.push({
            content: subChunk,
            label: `Sub-chunk ${i + 1}.${j + 1} (${subLines} lines, ${subSize} chars)`,
            index: allChunks.length
          });
        }
      } else {
        allChunks.push({
          content: fileDiff,
          label: `File chunk ${i + 1}/${files.length} (${fileLines} lines, ${fileSize} chars) - ${fileName || 'unknown'}`,
          index: allChunks.length
        });
      }
    }

    this.logger.log(`Skipped ${skippedFiles} excluded files`);
    this.logger.log(`Total chunks before merging: ${allChunks.length}`);

    // Apply intelligent chunk merging if enabled
    let finalChunks = allChunks;
    if (this.chunkMergeEnabled && allChunks.length > 1) {
      finalChunks = this.mergeSmallChunks(allChunks);
      this.logger.log(`After merging: ${finalChunks.length} chunks (reduced by ${allChunks.length - finalChunks.length})`);
    }

    this.logger.log(`Processing ${finalChunks.length} chunks in parallel batches of ${this.parallelBatchSize}...`);

    // Process chunks in parallel batches
    const allFeedback: AIFeedback[] = [];
    for (let i = 0; i < finalChunks.length; i += this.parallelBatchSize) {
      const batch = finalChunks.slice(i, i + this.parallelBatchSize);
      const batchNumber = Math.floor(i / this.parallelBatchSize) + 1;
      const totalBatches = Math.ceil(finalChunks.length / this.parallelBatchSize);

      this.logger.log(`Processing batch ${batchNumber}/${totalBatches} with ${batch.length} chunks...`);

      // Process this batch in parallel
      const batchPromises = batch.map(async (chunk, batchIndex) => {
        const chunkNumber = i + batchIndex + 1;
        this.logger.log(`Starting ${chunk.label}...`);

        try {
          const chunkFeedback = await this.analyzeDiffChunk(chunk.content, customRules);
          this.logger.log(`${chunk.label} yielded ${chunkFeedback.length} feedback items`);
          return chunkFeedback;
        } catch (error) {
          this.logger.error(`Failed to analyze ${chunk.label}:`, error.message);
          return []; // Return empty array on error
        }
      });

      // Wait for all chunks in this batch to complete
      const batchResults = await Promise.all(batchPromises);

      // Collect feedback from this batch
      for (const feedback of batchResults) {
        allFeedback.push(...feedback);
      }

      this.logger.log(`Batch ${batchNumber}/${totalBatches} complete. Running total: ${allFeedback.length} feedback items`);
    }

    this.logger.log(`Parallel chunked analysis complete. Total feedback items: ${allFeedback.length}`);
    return allFeedback;
  }

  private shouldExcludeFile(fileName: string): boolean {
    // Check if file matches any excluded patterns
    for (const pattern of this.excludedFilePatterns) {
      // Support both exact matches and path patterns
      if (pattern.includes('/')) {
        // Path pattern (e.g., "dist/", "node_modules/")
        if (fileName.includes(pattern) || fileName.startsWith(pattern)) {
          return true;
        }
      } else {
        // Filename pattern (e.g., "package-lock.json", ".DS_Store")
        if (fileName === pattern || fileName.endsWith('/' + pattern) || fileName.includes('/' + pattern)) {
          return true;
        }
      }
    }

    // Additional smart exclusions
    const smartExclusions = [
      // Lock files
      /package-lock\.json$/,
      /yarn\.lock$/,
      /pnpm-lock\.yaml$/,
      /composer\.lock$/,

      // Build artifacts
      /^dist\//,
      /^build\//,
      /^out\//,
      /\.min\.(js|css)$/,  // Minified files

      // Dependencies
      /^node_modules\//,
      /^vendor\//,

      // IDE/OS files
      /^\.vscode\//,
      /^\.idea\//,
      /\.DS_Store$/,
      /Thumbs\.db$/,

      // Git
      /^\.git\//,

      // Logs
      /\.log$/,

      // Coverage reports
      /^coverage\//,
      /coverage\..*$/,
    ];

    for (const pattern of smartExclusions) {
      if (pattern.test(fileName)) {
        return true;
      }
    }

    return false;
  }

  private async analyzeDiffChunk(
    diffChunk: string,
    customRules: string | null,
  ): Promise<AIFeedback[]> {
    // Extract diff hunks for context and line mapping
    const diffHunks = this.extractDiffHunks(diffChunk);

    // Build a map of line numbers to their actual code content
    const lineToCodeMap = this.buildLineToCodeMap(diffChunk);

    const parser = new JsonOutputParser<AIFeedback[]>();

    const prompt = new PromptTemplate({
      template: `
        You are an expert code reviewer. Your task is to analyze the following code diff chunk and provide feedback.
        Focus on identifying potential bugs, performance issues, and deviations from best practices.
        Do not comment on code style.

        CRITICAL REQUIREMENTS:
        1. Only comment on lines that actually exist in the diff
        2. Your comments must be specific to the code shown in the diff lines
        3. Do not make up or hallucinate code that isn't in the diff
        4. Focus on the actual changes: additions (+), deletions (-), and context lines ( )

        IMPORTANT: Your response must be valid JSON. Return an empty array [] if you find no issues.

        The output should be a JSON array of objects, where each object has the following format:
        {{
          "file": "path/to/file",
          "line": <line_number>,
          "comment": "Your comment here - be specific to the actual code change shown in the diff"
        }}

        Here are the custom rules to follow:
        {rules}

        Here is the code diff chunk to analyze:
        {diff}

        REMEMBER: Only comment on the actual code changes you see in the diff above. Do not reference code that isn't shown.
      `,
      inputVariables: ['diff', 'rules'],
    });

    const chain = prompt.pipe(this.model).pipe(parser);

    try {
      this.logger.log(`Invoking AI for chunk (${diffChunk.split('\n').length} lines)...`);
      const feedback = await chain.invoke({
        diff: diffChunk,
        rules: customRules || 'No custom rules provided.',
      });

      if (!Array.isArray(feedback)) {
        this.logger.error(`AI returned non-array response for chunk:`, typeof feedback, feedback);
        return [];
      }

      // Validate and enrich each feedback item with diff hunk context
      const validFeedback = feedback
        .filter(item => {
          if (!item || typeof item !== 'object') {
            this.logger.warn(`Invalid feedback item:`, item);
            return false;
          }
          if (!item.file || !item.comment || typeof item.line !== 'number') {
            this.logger.warn(`Malformed feedback item:`, item);
            return false;
          }
          return true;
        })
        .map(item => {
          // Find the appropriate diff hunk for this line
          const diffHunk = this.findDiffHunkForLine(diffHunks, item.line);

          // Validate that the comment is relevant to the actual code at this line
          const actualCode = lineToCodeMap.get(item.line);
          if (actualCode) {
            this.logger.log(`Line ${item.line} code: ${actualCode.trim()}`);
          }

          return {
            ...item,
            diffHunk: diffHunk || undefined
          };
        })
        .filter(item => {
          // Additional validation: ensure the comment is relevant to the actual code
          const actualCode = lineToCodeMap.get(item.line);
          if (!actualCode) {
            this.logger.warn(`No code found at line ${item.line} - filtering out comment`);
            return false;
          }

          // Strict relevance check - ensure comment is specifically about the actual code
          const codeLower = actualCode.toLowerCase();
          const commentLower = item.comment.toLowerCase();

          // Extract meaningful keywords from the actual code
          const codeKeywords = this.extractCodeKeywords(actualCode);
          const commentWords = commentLower.split(/\s+/);

          // Check for exact matches or very close matches
          let relevanceScore = 0;

          // Exact keyword matches
          for (const keyword of codeKeywords) {
            if (commentLower.includes(keyword.toLowerCase())) {
              relevanceScore += 2;
            }
          }

          // Check for variable/method names in the code
          const varMatches = actualCode.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
          if (varMatches) {
            for (const varName of varMatches) {
              if (commentLower.includes(varName.toLowerCase())) {
                relevanceScore += 3; // Higher weight for exact variable matches
              }
            }
          }

          // Check for specific patterns that indicate relevance
          if (codeLower.includes('if (!') && commentLower.includes('check')) relevanceScore += 2;
          if (codeLower.includes('return') && commentLower.includes('return')) relevanceScore += 1;
          if (codeLower.includes('error') && commentLower.includes('error')) relevanceScore += 2;
          if (codeLower.includes('status') && commentLower.includes('status')) relevanceScore += 2;

          // Require minimum relevance score
          if (relevanceScore < 2) {
            this.logger.warn(`Comment on line ${item.line} has low relevance (score: ${relevanceScore}) - filtering out`);
            this.logger.warn(`Code: "${actualCode.trim()}"`);
            this.logger.warn(`Comment: "${item.comment}"`);
            this.logger.warn(`Code keywords: [${codeKeywords.join(', ')}]`);
            return false;
          }

          this.logger.debug(`Comment on line ${item.line} passed relevance check (score: ${relevanceScore})`);
          return true;
        });

      if (validFeedback.length !== feedback.length) {
        this.logger.warn(`Filtered out ${feedback.length - validFeedback.length} invalid/irrelevant feedback items`);
      }

      return validFeedback;
    } catch (error) {
      this.logger.error(`Chunk analysis failed:`, error.message);

      // Try to extract more specific error information
      if (error.message?.includes('JSON')) {
        this.logger.error('JSON parsing error - AI likely returned malformed JSON');
      } else if (error.message?.includes('token')) {
        this.logger.error('Token limit exceeded for this chunk');
      } else if (error.message?.includes('timeout')) {
        this.logger.error('AI request timed out for this chunk');
      }

      // Return empty array instead of throwing
      return [];
    }
  }

  private buildLineToCodeMap(diffChunk: string): Map<number, string> {
    const lineToCodeMap = new Map<number, string>();
    const lines = diffChunk.split('\n');

    let currentFile = '';
    let currentHunkStartLine = 0;
    let inHunk = false;

    this.logger.debug(`Building line-to-code map for diff chunk with ${lines.length} lines`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track current file
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFile = match[1];
          this.logger.debug(`Processing file: ${currentFile}`);
        }
        inHunk = false; // Reset hunk state for new file
      }

      // Parse hunk headers
      if (line.startsWith('@@ ')) {
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          currentHunkStartLine = parseInt(match[2]);
          inHunk = true;
          this.logger.debug(`Starting hunk at line ${currentHunkStartLine} for file ${currentFile}`);
        }
      }

      // Map line numbers to their actual code content
      if (inHunk && currentHunkStartLine > 0) {
        if (line.startsWith('+')) {
          // Addition line - this corresponds to new code in the file
          const code = line.substring(1); // Remove + prefix
          lineToCodeMap.set(currentHunkStartLine, code);
          this.logger.debug(`Mapped line ${currentHunkStartLine}: ${code.trim()}`);
          currentHunkStartLine++;
        } else if (line.startsWith(' ')) {
          // Context line - this corresponds to existing code in the file
          const code = line.substring(1); // Remove space prefix
          lineToCodeMap.set(currentHunkStartLine, code);
          this.logger.debug(`Mapped context line ${currentHunkStartLine}: ${code.trim()}`);
          currentHunkStartLine++;
        } else if (line.startsWith('-')) {
          // Deletion line - this represents code that was removed
          // Don't increment line counter, but log it for debugging
          const removedCode = line.substring(1);
          this.logger.debug(`Removed line ${currentHunkStartLine}: ${removedCode.trim()}`);
          // Note: We don't map removed lines to current line numbers
        }
      }
    }

    this.logger.debug(`Completed line-to-code mapping: ${lineToCodeMap.size} mappings created`);
    return lineToCodeMap;
  }

  private extractCodeKeywords(code: string): string[] {
    const keywords: string[] = [];

    // Extract variable names, function names, etc.
    const varMatches = code.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
    if (varMatches) {
      keywords.push(...varMatches);
    }

    // Extract string literals
    const stringMatches = code.match(/'([^']*)'|"([^"]*)"/g);
    if (stringMatches) {
      keywords.push(...stringMatches.map(s => s.slice(1, -1)));
    }

    // Extract common keywords from the code
    const codeLower = code.toLowerCase();
    if (codeLower.includes('req.')) keywords.push('request', 'req');
    if (codeLower.includes('res.')) keywords.push('response', 'res');
    if (codeLower.includes('secret')) keywords.push('secret', 'webhook');
    if (codeLower.includes('signature')) keywords.push('signature', 'crypto');
    if (codeLower.includes('rawbody') || codeLower.includes('rawBody')) keywords.push('rawbody', 'body');
    if (codeLower.includes('middleware')) keywords.push('middleware');
    if (codeLower.includes('timingSafeEqual')) keywords.push('timingSafeEqual', 'crypto');

    return [...new Set(keywords)]; // Remove duplicates
  }

  private extractDiffHunks(diffChunk: string): Array<{ header: string; content: string; startLine: number; endLine: number }> {
    const lines = diffChunk.split('\n');
    const hunks: Array<{ header: string; content: string; startLine: number; endLine: number }> = [];

    let currentHunk: string[] = [];
    let currentHeader = '';
    let currentStartLine = 0;
    let inHunk = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('@@ ')) {
        // Save previous hunk if exists
        if (currentHunk.length > 0 && currentHeader) {
          hunks.push({
            header: currentHeader,
            content: currentHunk.join('\n'),
            startLine: currentStartLine,
            endLine: currentStartLine + currentHunk.length
          });
        }

        // Start new hunk
        currentHeader = line;
        currentHunk = [];
        currentStartLine = i;
        inHunk = true;

        // Parse the hunk header to get line numbers
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          currentStartLine = parseInt(match[2]); // New file line number
        }
      } else if (inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentHunk.push(line);
      } else if (line.startsWith('diff --git')) {
        // End of previous hunk when we hit a new file
        if (currentHunk.length > 0 && currentHeader) {
          hunks.push({
            header: currentHeader,
            content: currentHunk.join('\n'),
            startLine: currentStartLine,
            endLine: currentStartLine + currentHunk.length
          });
        }
        break; // Stop at next file
      }
    }

    // Add final hunk
    if (currentHunk.length > 0 && currentHeader) {
      hunks.push({
        header: currentHeader,
        content: currentHunk.join('\n'),
        startLine: currentStartLine,
        endLine: currentStartLine + currentHunk.length
      });
    }

    return hunks;
  }

  private findDiffHunkForLine(hunks: Array<{ header: string; content: string; startLine: number; endLine: number }>, targetLine: number): string | null {
    for (const hunk of hunks) {
      if (targetLine >= hunk.startLine && targetLine <= hunk.endLine) {
        // Return the hunk header + some context lines
        const contextLines = hunk.content.split('\n').slice(0, 10); // First 10 lines of context
        return hunk.header + '\n' + contextLines.join('\n');
      }
    }
    return null;
  }

  private splitLargeFileIntoSubChunks(fileDiff: string, chunkSize?: number): string[] {
    const lines = fileDiff.split('\n');
    const subChunks: string[] = [];
    const actualChunkSize = chunkSize || this.maxSubChunkLines;

    this.logger.log(`Sub-chunking large file (${lines.length} lines) into pieces of ~${actualChunkSize} lines each`);

    for (let i = 0; i < lines.length; i += actualChunkSize) {
      const endIndex = Math.min(i + actualChunkSize, lines.length);
      const subChunkLines = lines.slice(i, endIndex);
      const subChunk = subChunkLines.join('\n');

      // Only add non-empty chunks
      if (subChunk.trim().length > 0) {
        subChunks.push(subChunk);
      }
    }

    this.logger.log(`Created ${subChunks.length} sub-chunks from large file`);
    return subChunks;
  }

  private extractFileNameFromDiff(fileDiff: string): string | null {
    const lines = fileDiff.split('\n');
    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          return match[1];
        }
      }
      // Also check for +++ lines which contain the target filename
      if (line.startsWith('+++ ')) {
        const match = line.match(/\+\+\+ b\/(.+)/);
        if (match) {
          return match[1];
        }
      }
    }
    return null;
  }

  private shouldSubChunkFile(fileDiff: string, fileLines: number, fileSize: number, fileName: string | null): { needsSubChunking: boolean; reason: string; chunkSize?: number } {
    // Don't sub-chunk if file is small enough
    if (fileSize < 15000) { // 15KB threshold
      return { needsSubChunking: false, reason: 'File size under 15KB threshold' };
    }

    // Special handling for different file types
    if (fileName) {
      // JSON files: High density, be more lenient
      if (fileName.endsWith('.json') || fileName.endsWith('.lock')) {
        if (fileSize < 30000) { // 30KB for JSON files
          return { needsSubChunking: false, reason: 'JSON file under 30KB threshold' };
        }
        return { needsSubChunking: true, reason: 'Large JSON file needs chunking', chunkSize: 150 };
      }

      // Code files: Lower density, more aggressive chunking
      if (fileName.match(/\.(ts|js|py|java|cpp|c\+\+|cs|php|rb|go|rs)$/)) {
        if (fileLines > 400 || fileSize > 20000) {
          return { needsSubChunking: true, reason: 'Large code file needs chunking', chunkSize: 120 };
        }
      }

      // Text/Markdown files
      if (fileName.match(/\.(md|txt|yml|yaml|xml|html|css)$/)) {
        if (fileSize < 25000) {
          return { needsSubChunking: false, reason: 'Text file under 25KB threshold' };
        }
        return { needsSubChunking: true, reason: 'Large text file needs chunking', chunkSize: 100 };
      }
    }

    // Default logic: sub-chunk if either condition is met
    if (fileLines > 300 || fileSize > 25000) {
      return { needsSubChunking: true, reason: 'File exceeds size thresholds', chunkSize: this.maxSubChunkLines };
    }

    return { needsSubChunking: false, reason: 'File within acceptable limits' };
  }

  private mergeSmallChunks(chunks: { content: string; label: string; index: number }[]): { content: string; label: string; index: number }[] {
    if (chunks.length <= 1) {
      return chunks; // Nothing to merge
    }

    const mergedChunks: { content: string; label: string; index: number }[] = [];
    let currentBatch: { content: string; label: string; index: number }[] = [];
    let currentBatchSize = 0;
    let currentBatchLines = 0;

    this.logger.log(`Starting intelligent chunk merging for ${chunks.length} chunks...`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkLines = chunk.content.split('\n').length;
      const chunkSize = chunk.content.length;

      // Check if adding this chunk would exceed our limits
      const wouldExceedLimits = (currentBatchLines + chunkLines > this.maxChunkSize) ||
                               (currentBatchSize + chunkSize > this.maxChunkSize * 1000); // Rough char limit

      // If current batch is getting too big or this chunk is too big to add, finalize current batch
      if (wouldExceedLimits && currentBatch.length > 0) {
        this.finalizeMergedBatch(currentBatch, mergedChunks);
        currentBatch = [];
        currentBatchSize = 0;
        currentBatchLines = 0;
      }

      // If this chunk is too big by itself, don't merge it
      if (chunkLines > this.optimalChunkSize || chunkSize > this.optimalChunkSize * 100) {
        // Finalize any pending batch first
        if (currentBatch.length > 0) {
          this.finalizeMergedBatch(currentBatch, mergedChunks);
          currentBatch = [];
          currentBatchSize = 0;
          currentBatchLines = 0;
        }
        // Add this large chunk as-is
        mergedChunks.push(chunk);
        this.logger.log(`Large chunk kept separate: ${chunk.label}`);
        continue;
      }

      // Add chunk to current batch
      currentBatch.push(chunk);
      currentBatchSize += chunkSize;
      currentBatchLines += chunkLines;

      // If batch is at optimal size, finalize it
      if (currentBatchLines >= this.optimalChunkSize) {
        this.finalizeMergedBatch(currentBatch, mergedChunks);
        currentBatch = [];
        currentBatchSize = 0;
        currentBatchLines = 0;
      }
    }

    // Finalize any remaining batch
    if (currentBatch.length > 0) {
      this.finalizeMergedBatch(currentBatch, mergedChunks);
    }

    this.logger.log(`Chunk merging complete: ${chunks.length} → ${mergedChunks.length} chunks`);
    return mergedChunks;
  }

  private finalizeMergedBatch(batch: { content: string; label: string; index: number }[], mergedChunks: { content: string; label: string; index: number }[]): void {
    if (batch.length === 1) {
      // Single chunk, no merging needed
      mergedChunks.push(batch[0]);
      return;
    }

    // Merge multiple chunks
    const mergedContent = batch.map(chunk => chunk.content).join('\n\n');
    const totalLines = mergedContent.split('\n').length;
    const totalSize = mergedContent.length;

    const labels = batch.map(chunk => chunk.label.split(' (')[0]); // Extract base names
    const mergedLabel = `Merged (${batch.length} files: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? '...' : ''}) (${totalLines} lines, ${totalSize} chars)`;

    mergedChunks.push({
      content: mergedContent,
      label: mergedLabel,
      index: mergedChunks.length
    });

    this.logger.log(`Merged ${batch.length} chunks into 1: ${totalLines} lines, ${totalSize} chars`);
  }

  private splitDiffByFiles(diff: string): string[] {
    const lines = diff.split('\n');
    const fileChunks: string[] = [];
    let currentChunk: string[] = [];
    let inFile = false;
    let currentFileName = '';

    this.logger.log(`Parsing Git diff with ${lines.length} lines`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this is the start of a new file diff
      if (line.startsWith('diff --git')) {
        // Save previous chunk if it exists and has content
        if (currentChunk.length > 0) {
          const chunkContent = currentChunk.join('\n');
          if (chunkContent.trim().length > 0) {
            fileChunks.push(chunkContent);
            this.logger.log(`Saved file chunk: ${currentFileName || 'metadata'} (${currentChunk.length} lines)`);
          }
        }

        // Start new chunk
        currentChunk = [line];
        inFile = true;

        // Extract filename from diff line
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFileName = match[1];
        }
      } else if (line.startsWith('--- ') && inFile) {
        // This is the start of the actual diff content for the file
        currentChunk.push(line);
      } else if (line.startsWith('+++ ') && inFile) {
        // This is the target file line
        currentChunk.push(line);
      } else if (line.startsWith('@@ ') && inFile) {
        // This is a hunk header
        currentChunk.push(line);
      } else if (inFile && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        // This is diff content (added, removed, or context lines)
        currentChunk.push(line);
      } else if (line.startsWith('index ') && inFile) {
        // Index line
        currentChunk.push(line);
      } else if (line.startsWith('new file mode ') && inFile) {
        // New file mode
        currentChunk.push(line);
      } else if (line.startsWith('deleted file mode ') && inFile) {
        // Deleted file mode
        currentChunk.push(line);
      } else if (!inFile) {
        // Lines before first file (commit metadata, etc.)
        currentChunk.push(line);
      } else {
        // Other lines within a file diff that we want to include
        currentChunk.push(line);
      }
    }

    // Add the last chunk
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n');
      if (chunkContent.trim().length > 0) {
        fileChunks.push(chunkContent);
        this.logger.log(`Saved final file chunk: ${currentFileName || 'metadata'} (${currentChunk.length} lines)`);
      }
    }

    const validChunks = fileChunks.filter(chunk => chunk.trim().length > 0);
    this.logger.log(`Successfully parsed into ${validChunks.length} file chunks`);
    return validChunks;
  }
}
