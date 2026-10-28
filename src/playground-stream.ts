/** Keep incomplete lines until the next chunk so a split CRLF is never two newlines. */
export function splitSSEFrames(buffer: string, final = false): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  const endings = /\r\n|\r|\n/g;
  let frameStart = 0, lineStart = 0;
  let ending: RegExpExecArray | null;
  while ((ending = endings.exec(buffer)) !== null) {
    if (!final && ending[0] === '\r' && endings.lastIndex === buffer.length) break;
    if (ending.index === lineStart) {
      frames.push(buffer.slice(frameStart, lineStart));
      frameStart = endings.lastIndex;
    }
    lineStart = endings.lastIndex;
  }
  let remainder = buffer.slice(frameStart);
  if (final && remainder.trim()) { frames.push(remainder); remainder = ''; }
  return { frames, remainder };
}
