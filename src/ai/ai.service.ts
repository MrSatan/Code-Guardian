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
}

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  private readonly model: ChatGoogleGenerativeAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GOOGLE_API_KEY');
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY is not configured.');
    }
    console.log(apiKey);
    this.model = new ChatGoogleGenerativeAI({
      apiKey,
      model: 'gemini-2.5-pro',
      temperature: 0.3,
      maxOutputTokens: 2048,
    });
  }

  async analyzeDiff(
    diff: string,
    customRules: string | null,
  ): Promise<AIFeedback[]> {
    this.logger.log('Analyzing diff with AI...');

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

    const feedback = await chain.invoke({
      diff,
      rules: customRules || 'No custom rules provided.',
    });

    this.logger.log('AI analysis complete.');
    return feedback;
  }
}
