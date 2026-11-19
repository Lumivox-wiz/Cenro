//! Excel（.xlsx）阅读。
//!
//! xlsx 是 zip + XML：`xl/workbook.xml` 列工作表，`xl/sharedStrings.xml` 存共享字符串，
//! 每张表在 `xl/worksheets/sheetN.xml`。这里把每张表转成一个 HTML 表格，
//! 再复用 HTML 阅读器——这样「表格」是真的表格，而不是把单元格用空格拼成一行。
//!
//! 不做公式计算：直接取缓存值（`<v>`），与 Excel 里保存时看到的一致。

use crate::error::{AppError, Result};
use roxmltree::Document;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

/// 单表最多渲染的行数：再大就不是「阅读」，而且会让 DOM 卡死。
const MAX_ROWS: usize = 2000;

pub fn to_html(path: &Path) -> Result<String> {
    let mut archive = open(path)?;
    let workbook = read_entry(&mut archive, "xl/workbook.xml")?;
    let doc = Document::parse(&workbook)
        .map_err(|e| AppError::Other(format!("XLSX 解析失败：{e}")))?;

    let shared = read_shared_strings(&mut archive);
    let rels = read_rels(&mut archive);

    let mut out = String::new();
    for sheet in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "sheet")
    {
        let name = sheet.attribute("name").unwrap_or("工作表");
        let rid = sheet
            .attributes()
            .find(|a| a.name() == "id")
            .map(|a| a.value().to_string());
        let Some(rid) = rid else { continue };
        let Some(target) = rels.get(&rid) else { continue };
        let Ok(xml) = read_entry(&mut archive, target) else {
            continue;
        };

        out.push_str(&format!("<h2>{}</h2>", escape(name)));
        match sheet_html(&xml, &shared) {
            Ok(table) if !table.is_empty() => out.push_str(&table),
            _ => out.push_str("<p>（空表）</p>"),
        }
    }

    if out.is_empty() {
        return Err(AppError::Other("这个 Excel 里没有可读的工作表".into()));
    }
    Ok(out)
}

/// 合并单元格：`r1c1` 到 `r2c2`，行列都是从 0 起的闭区间。
struct Merge {
    row1: usize,
    col1: usize,
    row2: usize,
    col2: usize,
}

fn sheet_html(xml: &str, shared: &[String]) -> Result<String> {
    let doc = Document::parse(xml).map_err(|e| AppError::Other(format!("工作表解析失败：{e}")))?;

    // 行号用 Excel 里的绝对行号（`r` 属性）：合并单元格的 rowspan 要按它算，
    // 一旦中途丢行（整行空白），后面的跨度就全错位。
    let mut rows: Vec<(usize, Vec<(usize, String)>)> = Vec::new();
    for row in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "row")
    {
        let excel_row = row
            .attribute("r")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(rows.len() + 1)
            .saturating_sub(1);
        if excel_row >= MAX_ROWS {
            break;
        }

        let mut cells: Vec<(usize, String)> = Vec::new();
        for cell in row
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "c")
        {
            let Some(reference) = cell.attribute("r") else {
                continue;
            };
            let value = cell_value(cell, shared);
            if value.is_empty() {
                continue;
            }
            cells.push((column_index(reference), value));
        }
        rows.push((excel_row, cells));
    }

    let Some(first) = rows.iter().position(|(_, c)| !c.is_empty()) else {
        return Ok(String::new());
    };
    let last = rows
        .iter()
        .rposition(|(_, c)| !c.is_empty())
        .unwrap_or(rows.len() - 1);
    let rows = &rows[first..=last];

    let merges = parse_merges(&doc);

    let mut columns = rows
        .iter()
        .flat_map(|(_, cells)| cells.iter().map(|(col, _)| col + 1))
        .max()
        .unwrap_or(0);
    for m in &merges {
        columns = columns.max(m.col2 + 1);
    }
    if columns == 0 {
        return Ok(String::new());
    }

    // 被合并区域盖住、但不属于自己的格子：整格不输出，否则表格会多出一列
    let mut covered: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    let mut spans: HashMap<(usize, usize), (usize, usize)> = HashMap::new();
    for m in &merges {
        let rowspan = m.row2 - m.row1 + 1;
        let colspan = m.col2 - m.col1 + 1;
        if rowspan == 1 && colspan == 1 {
            continue;
        }
        spans.insert((m.row1, m.col1), (rowspan, colspan));
        for r in m.row1..=m.row2 {
            for c in m.col1..=m.col2 {
                if (r, c) != (m.row1, m.col1) {
                    covered.insert((r, c));
                }
            }
        }
    }

    let widths = column_widths(&doc, columns, rows);

    let mut out = String::with_capacity(rows.len() * columns * 24);
    // 外层可横向滚动：手机上一张 8 列的表挤进 380px 只会得到「一字一行」
    // 宽度写死成列宽之和：`table-layout: fixed` + `width: auto` 在 Chrome 里
    // 仍会按容器宽度分配，把 Excel 的列宽当比例用——整张表被压回屏幕宽。
    let total: u32 = widths.iter().sum();
    out.push_str(&format!(
        "<div class=\"sheet-scroll\"><table class=\"sheet\" style=\"width:{total}px\"><colgroup>"
    ));
    for w in &widths {
        out.push_str(&format!("<col style=\"width:{w}px\">"));
    }
    out.push_str("</colgroup>");

    for (excel_row, cells) in rows {
        out.push_str("<tr>");
        for col in 0..columns {
            if covered.contains(&(*excel_row, col)) {
                continue;
            }
            let text = cells
                .iter()
                .find(|(c, _)| *c == col)
                .map(|(_, v)| v.as_str())
                .unwrap_or("");
            // 只输出真正大于 1 的跨度：写 rowspan="1" 是噪音，也让 HTML 更难比对
            let tag = if *excel_row == rows[0].0 { "th" } else { "td" };
            let mut attrs = String::new();
            if let Some((rowspan, colspan)) = spans.get(&(*excel_row, col)) {
                if *rowspan > 1 {
                    attrs.push_str(&format!(" rowspan=\"{rowspan}\""));
                }
                if *colspan > 1 {
                    attrs.push_str(&format!(" colspan=\"{colspan}\""));
                }
            }
            out.push_str(&format!(
                "<{tag}{attrs}>{}</{tag}>",
                escape(text)
            ));
        }
        out.push_str("</tr>");
    }
    out.push_str("</table></div>");
    Ok(out)
}

/// 解析 `<mergeCells><mergeCell ref="A1:F1"/>`。
fn parse_merges(doc: &Document) -> Vec<Merge> {
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "mergeCell")
        .filter_map(|n| n.attribute("ref"))
        .filter_map(|r| {
            let (a, b) = r.split_once(':')?;
            let (row1, col1) = reference_to_pair(a)?;
            let (row2, col2) = reference_to_pair(b)?;
            Some(Merge {
                row1: row1.min(row2),
                row2: row1.max(row2),
                col1: col1.min(col2),
                col2: col1.max(col2),
            })
        })
        .collect()
}

/// "AB12" → (行 11, 列 27)，都是 0 起。
fn reference_to_pair(reference: &str) -> Option<(usize, usize)> {
    let digits: String = reference.chars().filter(|c| c.is_ascii_digit()).collect();
    let row: usize = digits.parse().ok()?;
    Some((row.saturating_sub(1), column_index(reference)))
}

/// 列宽（px）。
///
/// 优先用 Excel 自己存的 `<cols><col width="12.5">`：宽度单位是「默认字体的字符数」，
/// 换算成 px 大约是 `w * 7 + 5`。没有 `<cols>` 的老文件按内容长度估一个，
/// 总比让浏览器把中文压成一列一个字好。
fn column_widths(
    doc: &Document,
    columns: usize,
    rows: &[(usize, Vec<(usize, String)>)],
) -> Vec<u32> {
    let mut widths = vec![0u32; columns];
    for col in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "col")
    {
        let (Some(min), Some(max), Some(w)) = (
            col.attribute("min").and_then(|v| v.parse::<usize>().ok()),
            col.attribute("max").and_then(|v| v.parse::<usize>().ok()),
            col.attribute("width").and_then(|v| v.parse::<f32>().ok()),
        ) else {
            continue;
        };
        let px = (w * 7.0 + 5.0).round().clamp(44.0, 720.0) as u32;
        for c in min.saturating_sub(1)..max.min(columns) {
            widths[c] = px;
        }
    }

    // 缺省列按内容估宽：中文按 2 个字宽算，等宽数字按 1 个
    for (index, width) in widths.iter_mut().enumerate() {
        if *width > 0 {
            continue;
        }
        let chars = rows
            .iter()
            .filter_map(|(_, cells)| cells.iter().find(|(c, _)| *c == index))
            .map(|(_, v)| display_width(v))
            .max()
            .unwrap_or(4);
        *width = (chars as u32 * 8 + 18).clamp(56, 420);
    }
    widths
}

/// 估算显示宽度：CJK 与全角标点算 2，其余算 1。
fn display_width(text: &str) -> usize {
    text.chars()
        .map(|c| if (c as u32) > 0x2e7f { 2 } else { 1 })
        .max()
        .unwrap_or(1)
        .max(1)
}

fn cell_value(cell: roxmltree::Node, shared: &[String]) -> String {
    let kind = cell.attribute("t").unwrap_or("");
    let raw = cell
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "v")
        .and_then(|n| n.text())
        .unwrap_or("");
    match kind {
        "s" => raw
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|i| shared.get(i).cloned())
            .unwrap_or_default(),
        "inlineStr" => cell
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "t")
            .filter_map(|n| n.text())
            .collect(),
        "b" => {
            if raw.trim() == "1" {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        _ => raw.to_string(),
    }
}

/// "AB12" → 27（0 基）
fn column_index(reference: &str) -> usize {
    let mut col = 0usize;
    for ch in reference.chars() {
        if ch.is_ascii_alphabetic() {
            col = col * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
        } else {
            break;
        }
    }
    col.saturating_sub(1)
}

fn read_shared_strings(archive: &mut ZipArchive<std::fs::File>) -> Vec<String> {
    let Ok(xml) = read_entry(archive, "xl/sharedStrings.xml") else {
        return Vec::new();
    };
    let Ok(doc) = Document::parse(&xml) else {
        return Vec::new();
    };
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "si")
        .map(|si| {
            si.descendants()
                .filter(|n| n.is_element() && n.tag_name().name() == "t")
                .filter_map(|n| n.text())
                .collect::<String>()
        })
        .collect()
}

fn read_rels(archive: &mut ZipArchive<std::fs::File>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(xml) = read_entry(archive, "xl/_rels/workbook.xml.rels") else {
        return map;
    };
    let Ok(doc) = Document::parse(&xml) else {
        return map;
    };
    for rel in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Relationship")
    {
        let (Some(id), Some(target)) = (rel.attribute("Id"), rel.attribute("Target")) else {
            continue;
        };
        // Target 可能是 "worksheets/sheet1.xml" 或 "/xl/worksheets/sheet1.xml"
        let target = target.trim_start_matches('/');
        let path = if target.starts_with("xl/") {
            target.to_string()
        } else {
            format!("xl/{target}")
        };
        map.insert(id.to_string(), path);
    }
    map
}

fn open(path: &Path) -> Result<ZipArchive<std::fs::File>> {
    let file = std::fs::File::open(path)?;
    ZipArchive::new(file).map_err(|e| AppError::Other(format!("Excel 文件无效：{e}")))
}

fn read_entry(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Result<String> {
    let mut f = archive
        .by_name(name)
        .map_err(|_| AppError::Other(format!("Excel 缺少 {name}")))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_column_index() {
        assert_eq!(column_index("A1"), 0);
        assert_eq!(column_index("B2"), 1);
        assert_eq!(column_index("Z9"), 25);
        assert_eq!(column_index("AA1"), 26);
        assert_eq!(column_index("AB100"), 27);
    }

    /// 开发期辅助：`CENRO_XLSX_SAMPLE=<xlsx> CENRO_XLSX_OUT=<html> cargo test --lib dump_xlsx -- --ignored`
    #[test]
    #[ignore = "开发期辅助：需要 CENRO_XLSX_SAMPLE 与 CENRO_XLSX_OUT"]
    fn dump_xlsx() {
        let (Ok(src), Ok(out)) = (
            std::env::var("CENRO_XLSX_SAMPLE"),
            std::env::var("CENRO_XLSX_OUT"),
        ) else {
            return;
        };
        let html = to_html(Path::new(&src)).unwrap();
        std::fs::write(&out, html).unwrap();
        println!("wrote {out}");
    }

    #[test]
    fn renders_shared_and_inline_cells() {
        let shared = vec!["姓名".to_string(), "张三".to_string()];
        let xml = r#"<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
          <row r="2"><c r="A2" t="inlineStr"><is><t>备注</t></is></c><c r="C2"><v>42</v></c></row>
        </sheetData></worksheet>"#;
        let html = sheet_html(xml, &shared).unwrap();
        assert!(html.contains("<th>姓名</th>"), "{html}");
        assert!(html.contains("<td>备注</td>"), "{html}");
        // 第二行缺 B 列，要补空单元格，否则 42 会左移
        assert!(html.contains("<td>备注</td><td></td><td>42</td>"), "{html}");
        // 三列各有一个宽度，否则手机浏览器会把中文压成一列一个字
        assert_eq!(html.matches("<col style=\"width:").count(), 3, "{html}");
        assert!(html.starts_with("<div class=\"sheet-scroll\">"), "{html}");
    }

    /// 合并单元格：首行 A1:C1 合并，输出一个 colspan=3 的表头，
    /// 且不再补 B1/C1 两个空 td（否则表头右侧会多出两格）。
    #[test]
    fn applies_merge_spans() {
        let xml = r#"<worksheet><sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>
          <row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><v>3</v></c></row>
        </sheetData>
        <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>"#;
        let html = sheet_html(xml, &[]).unwrap();
        assert!(html.contains(r#"<th colspan="3">标题</th>"#), "{html}");
        // 第二行三个格子照常
        assert!(html.contains("<td>1</td><td>2</td><td>3</td>"), "{html}");
        // 首行只应有一个单元格
        let first_row = html.split("<tr>").nth(1).unwrap();
        assert_eq!(first_row.matches('<').count(), 3, "{html}");
    }

    /// 竖向合并：rowspan 生效，被盖住的下方格子不输出
    #[test]
    fn applies_row_spans() {
        let xml = r#"<worksheet><sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>类别</t></is></c><c r="B1"><v>1</v></c></row>
          <row r="2"><c r="B2"><v>2</v></c></row>
        </sheetData>
        <mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>"#;
        let html = sheet_html(xml, &[]).unwrap();
        assert!(html.contains(r#"rowspan="2""#), "{html}");
        // 第二行只有 B 列一个 td
        let second = html.split("<tr>").nth(2).unwrap();
        assert_eq!(second.matches("<td>").count(), 1, "{html}");
    }

    /// Excel 自己给的列宽要照搬（字符宽 × 7 + 5）
    #[test]
    fn uses_excel_column_widths() {
        let xml = r#"<worksheet><cols><col min="1" max="2" width="10"/></cols><sheetData>
          <row r="1"><c r="A1"><v>1</v></c></row>
        </sheetData></worksheet>"#;
        let html = sheet_html(xml, &[]).unwrap();
        assert!(html.contains(r#"<col style="width:75px">"#), "{html}");
    }

    /// 中间的空行必须保留：合并单元格的 rowspan 靠绝对行号算，
    /// 中途丢一行会让下面的跨度整体错位。
    #[test]
    fn keeps_blank_row_in_the_middle() {
        let xml = r#"<worksheet><sheetData>
          <row r="1"><c r="A1"><v>1</v></c></row>
          <row r="2"></row>
          <row r="3"><c r="A3"><v>3</v></c></row>
        </sheetData></worksheet>"#;
        let html = sheet_html(xml, &[]).unwrap();
        assert_eq!(html.matches("<tr>").count(), 3, "{html}");
    }
}
