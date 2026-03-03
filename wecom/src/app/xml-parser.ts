import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false,
});

export function parseAppXml(xml: string): Record<string, any> {
  const obj = xmlParser.parse(xml);
  const root = (obj as any)?.xml ?? obj;
  return root ?? {};
}
