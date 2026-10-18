// Tiny Verilog syntax highlighter shared by Session A scenes (01-code, 02-iverilog).
const KW = new Set('module endmodule parameter localparam always initial begin end if else for while repeat wait forever case endcase default posedge negedge assign function endfunction task endtask generate endgenerate'.split(' '));
const TY = new Set('input output inout wire reg integer logic signed unsigned genvar'.split(' '));

const RX = /(\/\/.*$)|("(?:[^"\\]|\\.)*")|(`\w+)|(\$\w+)|(\d*'[sS]?[bdhoBDHO][0-9a-fA-F_xzXZ?]+|\b\d+(?:\.\d+)?\b)|(#\d+)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[{}()\[\];,.:?<>=+\-*\/&|!~^@#])/g;

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(line) {
  let out = '', last = 0, m;
  RX.lastIndex = 0;
  while ((m = RX.exec(line))) {
    if (m.index > last) out += esc(line.slice(last, m.index));
    const t = m[0];
    let c = '';
    if (m[1]) c = 'tk-com';
    else if (m[2]) c = 'tk-str';
    else if (m[3]) c = 'tk-dir';
    else if (m[4]) c = 'tk-sys';
    else if (m[5] || m[6]) c = 'tk-num';
    else if (m[7]) c = KW.has(t) ? 'tk-kw' : TY.has(t) ? 'tk-ty' : '';
    else if (m[8]) c = 'tk-op';
    out += c ? `<span class="${c}">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
    if (t.length === 0) RX.lastIndex++;
  }
  if (last < line.length) out += esc(line.slice(last));
  return out;
}

export const splitLines = (txt) => txt.replace(/\r/g, '').replace(/\n$/, '').split('\n');
