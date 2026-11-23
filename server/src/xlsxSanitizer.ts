// Remove artefatos de formatação (tabelas/autofiltro) que o ExcelJS não consegue
// interpretar. Nenhuma célula é alterada. Compartilhado pelo leitor universal
// e pelo adaptador da política comercial.
import JSZip from 'jszip';

export async function sanitizarXlsx(buf: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return buf;
  }
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/tables\//.test(name)) {
      delete zip.files[name];
      continue;
    }
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      const x = await zip.files[name].async('string');
      zip.file(name, x.replace(/<tableParts[\s\S]*?<\/tableParts>/g, '').replace(/<tableParts[^>]*\/>/g, ''));
      continue;
    }
    if (/^xl\/worksheets\/_rels\//.test(name)) {
      const x = await zip.files[name].async('string');
      zip.file(name, x.replace(/<Relationship[^>]*\/table[^"]*"[^>]*\/>/gi, ''));
      continue;
    }
  }
  const ct = zip.files['[Content_Types].xml'];
  if (ct) {
    const x = await ct.async('string');
    zip.file('[Content_Types].xml', x.replace(/<Override[^>]*PartName="\/xl\/tables\/[^"]*"[^>]*\/>/gi, ''));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
