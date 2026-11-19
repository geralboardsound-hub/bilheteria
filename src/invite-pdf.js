import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const white = rgb(1, 1, 1);
const violet = rgb(.19, .07, .33);
const gold = rgb(.97, .81, .51);
const clean = value => String(value ?? '').normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');

export async function invitePDF(event, orderId, tickets, art) {
  const doc = await PDFDocument.create();
  doc.setTitle('Convites Boardsound - ' + orderId);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const poster = art ? await doc.embedJpg(art) : null;
  for (const { index, lot, qr } of tickets) {
    const page = doc.addPage([792, 396]);
    const text = (value, x, y, size, font = regular, color = white, width = 487) => {
      let label = clean(value);
      if (font.widthOfTextAtSize(label, size) > width) {
        while (label && font.widthOfTextAtSize(label + '...', size) > width) label = label.slice(0, -1);
        label += '...';
      }
      page.drawText(label, { x, y, size, font, color });
    };
    page.drawRectangle({ x:0, y:0, width:553, height:396, color:violet });
    if (poster) {
      const d = poster.scaleToFit(505, 181);
      page.drawImage(poster, { x:24+(505-d.width)/2, y:191, ...d });
    }
    text('BOARDSOUND  /  CONVITE DIGITAL', 24, 166, 11, bold, gold);
    text(event.name, 24, 135, 23, bold);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(event.date || '') ? event.date.split('-').reverse().join('/') : 'Data a confirmar';
    text(`${date}  |  ${event.venue || 'Local a confirmar'}`, 24, 103, 14);
    text(`Horário da bilheteira: ${event.time || 'a confirmar'}`, 24, 79, 15, bold, gold);
    if (poster && event.time !== '19:30') text('Segue o horário acima, não o impresso na arte.', 24, 57, 11);
    text('A validade é verificada pela equipa no momento da leitura.', 24, 26, 10);
    text(`INGRESSO ${index}  /  ${lot}`, 582, 334, 12, bold, violet, 185);
    const n = qr.getModuleCount(), unit = 180 / (n + 8);
    let path = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!qr.isDark(y,x)) continue;
      const start = x;
      while (x + 1 < n && qr.isDark(y,x+1)) x++;
      path += `M${start} ${y}h${x-start+1}v1H${start}Z `;
    }
    page.drawSvgPath(path, { x:582+4*unit, y:311-4*unit, scale:unit, color:rgb(0,0,0) });
    text(`${orderId}-${index}`, 582, 123, 14, bold, violet, 185);
    text('Apresenta este QR à entrada.', 582, 100, 11, regular, violet, 185);
  }
  return doc.save();
}
