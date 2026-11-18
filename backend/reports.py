import csv
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

EXPORT_DIR = Path(tempfile.gettempdir()) / "skytrack_reports"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_FORMATS = {"csv", "excel", "pdf"}

# SkyTrack brand palette
BRAND_DARK = "0F1727"
BRAND_PRIMARY = "1F3A5F"
BRAND_ACCENT = "38A3FF"
BRAND_ACCENT_2 = "22D3EE"
BRAND_ZEBRA = "EEF2F7"
BRAND_TEXT_DIM = "6B7C96"

HEADER_FILL = PatternFill("solid", fgColor=BRAND_PRIMARY)
HEADER_FONT = Font(bold=True, color="FFFFFF", size=10, name="Calibri")
TITLE_FONT = Font(bold=True, color="FFFFFF", size=16, name="Calibri")
SUBTITLE_FONT = Font(color=BRAND_TEXT_DIM, size=10, italic=True, name="Calibri")
BODY_FONT = Font(color="1F2937", size=10, name="Calibri")
BODY_BOLD = Font(bold=True, color="1F2937", size=10, name="Calibri")

THIN = Side(style="thin", color="CBD5E1")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)
RIGHT = Alignment(horizontal="right", vertical="center", wrap_text=True)

HEADER_BG = colors.HexColor(f"#{BRAND_PRIMARY}")
ZEBRA_BG = colors.HexColor(f"#{BRAND_ZEBRA}")
GRID_COLOR = colors.HexColor("#CBD5E1")
BODY_TEXT = colors.HexColor("#1F2937")

EXTENSIONS = {"csv": "csv", "excel": "xlsx", "pdf": "pdf"}


def _filename(icao24: str, kind: str, fmt: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    ext = EXTENSIONS.get(fmt, fmt)
    return f"skytrack_{icao24.lower()}_{kind}_{stamp}.{ext}"


def _write_csv(path: Path, headers: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(rows)


def _style_excel_sheet(ws, title: str, subtitle: str, headers: list[str], rows: list[list]) -> None:
    last_col = get_column_letter(len(headers))
    last_row = len(rows) + 4  # title, subtitle, blank, header

    # Title banner (merged across all columns)
    ws.merge_cells(f"A1:{last_col}1")
    title_cell = ws["A1"]
    title_cell.value = title
    title_cell.font = TITLE_FONT
    title_cell.fill = PatternFill("solid", fgColor=BRAND_PRIMARY)
    title_cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws.row_dimensions[1].height = 30

    # Subtitle
    ws.merge_cells(f"A2:{last_col}2")
    subtitle_cell = ws["A2"]
    subtitle_cell.value = subtitle
    subtitle_cell.font = SUBTITLE_FONT
    subtitle_cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws.row_dimensions[2].height = 18

    # Header row (row 4)
    header_row = 4
    for col_index, header in enumerate(headers, 1):
        cell = ws.cell(row=header_row, column=col_index, value=header)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.border = BORDER
        cell.alignment = CENTER

    # Data rows
    for row_index, row in enumerate(rows, header_row + 1):
        is_zebra = (row_index - (header_row + 1)) % 2 == 1
        for col_index, value in enumerate(row, 1):
            cell = ws.cell(row=row_index, column=col_index, value=value)
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = LEFT if col_index == 1 else RIGHT
            if is_zebra:
                cell.fill = PatternFill("solid", fgColor=BRAND_ZEBRA)

    # Column widths
    for col_index in range(1, len(headers) + 1):
        column_letter = get_column_letter(col_index)
        max_len = len(str(headers[col_index - 1]))
        for row in rows:
            value = row[col_index - 1]
            if value is not None:
                max_len = max(max_len, len(str(value)))
        ws.column_dimensions[column_letter].width = min(max(max_len + 2, 10), 52)

    # Freeze header row
    ws.freeze_panes = f"A{header_row + 1}"

    # Auto filter
    ws.auto_filter.ref = f"A{header_row}:{last_col}{last_row}"

    # Print setup: landscape, fit to width
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.tabColor = BRAND_ACCENT
    ws.sheet_view.showGridLines = False


def _write_excel(path: Path, title: str, headers: list[str], rows: list[list]) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]

    subtitle = (
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}  |  "
        f"Records: {len(rows)}"
    )
    _style_excel_sheet(ws, title, subtitle, headers, rows)
    wb.save(path)


def _pdf_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor(f"#{BRAND_TEXT_DIM}"))
    canvas.setFont("Helvetica", 8)
    canvas.drawString(
        22,
        14,
        f"SkyTrack | Flight Report | Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
    )
    canvas.drawRightString(
        letter[0] - 22,
        14,
        f"Page {doc.page}",
    )
    canvas.setStrokeColor(GRID_COLOR)
    canvas.setLineWidth(0.4)
    canvas.line(22, 26, letter[0] - 22, 26)
    canvas.restoreState()


def _write_pdf(path: Path, title: str, headers: list[str], rows: list[list]) -> None:
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=17,
        textColor=colors.white,
        spaceAfter=0,
        alignment=0,
    )
    subtitle_style = ParagraphStyle(
        "subtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        textColor=colors.HexColor(f"#{BRAND_TEXT_DIM}"),
        spaceAfter=0,
        alignment=0,
    )

    # Colored header band
    band = Table(
        [[Paragraph(title, title_style)]],
        colWidths=[letter[0] - 44],
        rowHeights=[34],
    )
    band.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), HEADER_BG),
                ("LEFTPADDING", (0, 0), (-1, -1), 16),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )

    subtitle = Paragraph(
        f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}  |  "
        f"Records: {len(rows)}",
        subtitle_style,
    )

    story = [band, Spacer(1, 10), subtitle, Spacer(1, 14)]

    data = [headers] + [[str(cell) for cell in row] for row in rows]
    table = Table(data, repeatRows=1)
    style_commands = [
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 7),
        ("FONTSIZE", (0, 1), (-1, -1), 6.5),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("TEXTCOLOR", (0, 1), (-1, -1), BODY_TEXT),
        ("GRID", (0, 0), (-1, -1), 0.4, GRID_COLOR),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA_BG]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    table.setStyle(TableStyle(style_commands))
    story.append(table)

    doc = SimpleDocTemplate(
        str(path),
        pagesize=landscape(letter),
        title=title,
        leftMargin=22,
        rightMargin=22,
        topMargin=22,
        bottomMargin=34,
    )
    doc.build(story, onFirstPage=_pdf_footer, onLaterPages=_pdf_footer)


def build_report(
    icao24: str, kind: str, title: str, headers: list[str], rows: list[list], fmt: str
):
    fmt = fmt.lower()
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError(f"Unsupported format: {fmt}")

    name = _filename(icao24, kind, fmt)
    path = EXPORT_DIR / name

    if fmt == "csv":
        _write_csv(path, headers, rows)
        media_type = "text/csv"
    elif fmt == "excel":
        _write_excel(path, title, headers, rows)
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        _write_pdf(path, title, headers, rows)
        media_type = "application/pdf"

    return path, name, media_type


def tracking_history_rows(records: list[dict]) -> tuple[list[str], list[list]]:
    headers = [
        "Timestamp (UTC)",
        "ICAO24",
        "Callsign",
        "Origin Country",
        "Latitude",
        "Longitude",
        "Altitude (m)",
        "Altitude (ft)",
        "On Ground",
        "Velocity (m/s)",
        "Velocity (kt)",
        "Heading (deg)",
    ]
    rows = []
    for record in records:
        altitude = record.get("altitude")
        velocity = record.get("velocity")
        rows.append(
            [
                record.get("timestamp", ""),
                record.get("icao24", ""),
                record.get("callsign") or "",
                record.get("origin_country") or "",
                record.get("latitude") if record.get("latitude") is not None else "",
                record.get("longitude") if record.get("longitude") is not None else "",
                altitude if altitude is not None else "",
                round(altitude * 3.28084, 1) if altitude is not None else "",
                "Yes" if record.get("on_ground") else "No",
                velocity if velocity is not None else "",
                round(velocity * 1.94384, 1) if velocity is not None else "",
                record.get("heading") if record.get("heading") is not None else "",
            ]
        )
    return headers, rows


def route_details_rows(route: dict) -> tuple[list[str], list[list]]:
    headers = [
        "ICAO24",
        "Callsign",
        "Departure ICAO",
        "Departure IATA",
        "Departure Airport",
        "Departure City",
        "Departure Country",
        "Departure Lat",
        "Departure Lon",
        "Arrival ICAO",
        "Arrival IATA",
        "Arrival Airport",
        "Arrival City",
        "Arrival Country",
        "Arrival Lat",
        "Arrival Lon",
        "Planned Distance (km)",
        "Generated At (UTC)",
    ]
    departure = route.get("departure") or {}
    arrival = route.get("arrival") or {}
    planned = route.get("planned_distance_km")
    row = [
        route.get("icao24", ""),
        route.get("callsign") or "",
        departure.get("icao") or "",
        departure.get("iata") or "",
        departure.get("name") or "",
        departure.get("municipality") or "",
        departure.get("country") or "",
        departure.get("latitude") if departure.get("latitude") is not None else "",
        departure.get("longitude") if departure.get("longitude") is not None else "",
        arrival.get("icao") or "",
        arrival.get("iata") or "",
        arrival.get("name") or "",
        arrival.get("municipality") or "",
        arrival.get("country") or "",
        arrival.get("latitude") if arrival.get("latitude") is not None else "",
        arrival.get("longitude") if arrival.get("longitude") is not None else "",
        planned if planned is not None else "",
        datetime.now(timezone.utc).isoformat(),
    ]
    return headers, [row]


def flight_statistics_rows(trajectory: dict) -> tuple[list[str], list[list]]:
    headers = [
        "ICAO24",
        "Callsign",
        "Start Time",
        "End Time",
        "Total Waypoints",
        "Total Duration (s)",
        "Total Duration (h:m:s)",
        "Actual Distance (km)",
        "Planned Distance (km)",
        "Progress (%)",
        "Remaining Distance (km)",
        "Estimated Arrival",
        "Current Lat",
        "Current Lon",
        "Current Altitude (m)",
        "Current Heading (deg)",
        "Current Speed (kt)",
        "On Ground",
        "Current Timestamp",
    ]
    current = trajectory.get("current_position") or {}
    speed_kts = current.get("velocity_kts")

    total_seconds = trajectory.get("total_duration_seconds")
    if total_seconds is not None:
        total = int(total_seconds)
        hours = total // 3600
        minutes = (total % 3600) // 60
        secs = total % 60
        duration = (
            f"{hours}h {minutes:02d}m {secs:02d}s"
            if hours
            else f"{minutes}m {secs:02d}s"
        )
    else:
        duration = ""

    row = [
        trajectory.get("icao24", ""),
        trajectory.get("callsign") or "",
        trajectory.get("start_time") or "",
        trajectory.get("end_time") or "",
        (
            trajectory.get("total_waypoints")
            if trajectory.get("total_waypoints") is not None
            else ""
        ),
        (
            trajectory.get("total_duration_seconds")
            if trajectory.get("total_duration_seconds") is not None
            else ""
        ),
        duration,
        (
            trajectory.get("actual_distance_km")
            if trajectory.get("actual_distance_km") is not None
            else ""
        ),
        (
            trajectory.get("planned_distance_km")
            if trajectory.get("planned_distance_km") is not None
            else ""
        ),
        (
            trajectory.get("progress_percent")
            if trajectory.get("progress_percent") is not None
            else ""
        ),
        (
            trajectory.get("remaining_distance_km")
            if trajectory.get("remaining_distance_km") is not None
            else ""
        ),
        trajectory.get("estimated_arrival") or "",
        current.get("latitude") if current.get("latitude") is not None else "",
        current.get("longitude") if current.get("longitude") is not None else "",
        current.get("altitude") if current.get("altitude") is not None else "",
        current.get("heading") if current.get("heading") is not None else "",
        speed_kts if speed_kts is not None else "",
        "Yes" if current.get("on_ground") else "No",
        current.get("timestamp") or "",
    ]
    return headers, [row]
