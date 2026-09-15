/**
 * Strands Sentinel - FormattedAgentMessage
 * Renders agent responses directly on the background matching the Gemini / clean AI chat aesthetic:
 * - Direct background rendering (no card borders or bubble)
 * - Crisp typography (#E3E3E3, 15px, leading-6)
 * - Hollow circular bullet points (○) with bold headers (**Header**: text)
 * - Code blocks and inline formatting
 */

import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '@/components/ui';

interface FormattedAgentMessageProps {
  content: string;
}

interface TextSegment {
  text: string;
  isBold?: boolean;
  isCode?: boolean;
  isItalic?: boolean;
}

function parseInlineFormatting(rawText: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // Matches **bold**, `code`, *italic*
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(rawText)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: rawText.substring(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      segments.push({
        text: token.slice(2, -2),
        isBold: true,
      });
    } else if (token.startsWith('`') && token.endsWith('`')) {
      segments.push({
        text: token.slice(1, -1),
        isCode: true,
      });
    } else if (token.startsWith('*') && token.endsWith('*')) {
      segments.push({
        text: token.slice(1, -1),
        isItalic: true,
      });
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < rawText.length) {
    segments.push({ text: rawText.substring(lastIndex) });
  }

  return segments;
}

interface Block {
  type: 'paragraph' | 'bullet' | 'code' | 'heading';
  content: string;
  level?: number;
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length > 0) {
      blocks.push({
        type: 'paragraph',
        content: paragraphBuffer.join(' ').trim(),
      });
      paragraphBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCode) {
        blocks.push({
          type: 'code',
          content: codeBuffer.join('\n'),
        });
        codeBuffer = [];
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    // Check for bullet list item (*, -, •, o)
    const bulletMatch = trimmed.match(/^([*\-•o]|\d+\.)\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({
        type: 'bullet',
        content: bulletMatch[2],
      });
      continue;
    }

    // Check for headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      continue;
    }

    paragraphBuffer.push(trimmed);
  }

  flushParagraph();
  if (inCode && codeBuffer.length > 0) {
    blocks.push({ type: 'code', content: codeBuffer.join('\n') });
  }

  return blocks;
}

export function FormattedAgentMessage({ content }: FormattedAgentMessageProps) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <View className="w-full py-1">
      {blocks.map((block, bIdx) => {
        if (block.type === 'bullet') {
          const segments = parseInlineFormatting(block.content);
          return (
            <View key={bIdx} className="flex-row items-start mb-3.5 pl-1 pr-2">
              {/* Hollow circular bullet icon (○) exactly as in screenshot */}
              <View className="w-2.5 h-2.5 rounded-full border-[1.5px] border-zinc-400 mt-1.5 mr-3 shrink-0" />
              <Text className="flex-1 text-[15px] leading-6 text-zinc-200">
                {segments.map((seg, sIdx) => {
                  if (seg.isBold) {
                    return (
                      <Text key={sIdx} className="font-semibold text-white text-[15px]">
                        {seg.text}
                      </Text>
                    );
                  }
                  if (seg.isCode) {
                    return (
                      <Text key={sIdx} className="font-mono text-emerald-300 text-[13px] bg-zinc-800/80 px-1 py-0.5 rounded">
                        {seg.text}
                      </Text>
                    );
                  }
                  if (seg.isItalic) {
                    return (
                      <Text key={sIdx} className="italic text-zinc-300 text-[15px]">
                        {seg.text}
                      </Text>
                    );
                  }
                  return (
                    <Text key={sIdx} className="text-zinc-200 text-[15px]">
                      {seg.text}
                    </Text>
                  );
                })}
              </Text>
            </View>
          );
        }

        if (block.type === 'heading') {
          return (
            <Text key={bIdx} className="text-white font-semibold text-base mb-2 mt-1">
              {block.content}
            </Text>
          );
        }

        if (block.type === 'code') {
          return (
            <View key={bIdx} className="p-3 my-2 bg-[#121418] rounded-xl border border-zinc-800/80">
              <Text className="font-mono text-xs text-emerald-400 leading-5">
                {block.content}
              </Text>
            </View>
          );
        }

        // Standard paragraph
        const segments = parseInlineFormatting(block.content);
        return (
          <Text key={bIdx} className="text-[15px] leading-6 text-zinc-200 mb-3.5">
            {segments.map((seg, sIdx) => {
              if (seg.isBold) {
                return (
                  <Text key={sIdx} className="font-semibold text-white text-[15px]">
                    {seg.text}
                  </Text>
                );
              }
              if (seg.isCode) {
                return (
                  <Text key={sIdx} className="font-mono text-emerald-300 text-[13px] bg-zinc-800/80 px-1 py-0.5 rounded">
                    {seg.text}
                  </Text>
                );
              }
              if (seg.isItalic) {
                return (
                  <Text key={sIdx} className="italic text-zinc-300 text-[15px]">
                    {seg.text}
                  </Text>
                );
              }
              return (
                <Text key={sIdx} className="text-zinc-200 text-[15px]">
                  {seg.text}
                </Text>
              );
            })}
          </Text>
        );
      })}
    </View>
  );
}

export default FormattedAgentMessage;
