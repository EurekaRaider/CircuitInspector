#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import os
import shutil
import tempfile
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures" / "schematic"
POPPLER = Path(os.environ.get("CIRCUIT_INSPECTOR_PDFTOPPM") or shutil.which("pdftoppm") or "pdftoppm")


def component(canvas: Canvas, refdes: str, x: float, y: float, width: float, height: float, rows: list[tuple[str, str]]) -> None:
    canvas.setLineWidth(1.2)
    canvas.rect(x, y, width, height)
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawCentredString(x + width / 2, y + height - 18, refdes)
    canvas.setFont("Courier", 8)
    for index, (pin, name) in enumerate(rows):
        pin_y = y + height - 42 - index * 28
        canvas.line(x - 42, pin_y, x, pin_y)
        canvas.drawRightString(x - 5, pin_y - 3, pin)
        canvas.drawString(x + 7, pin_y - 3, name)


def evidence_rows(canvas: Canvas, title: str, rows: list[str]) -> None:
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(34, 575, title)
    canvas.setFont("Courier", 8)
    y = 557
    for row in rows:
        canvas.drawString(34, y, row)
        y -= 12


def product_pdf(path: Path) -> None:
    canvas = Canvas(str(path), pagesize=landscape(letter), pageCompression=0)
    canvas.setTitle("CircuitInspector product schematic fixture")
    evidence_rows(canvas, "CONTROLLED PIN EVIDENCE", [
        "J1 PIN 1 NET WIB_SCL",
        "J1 PIN 2 NET GND",
        "R104 PIN 1 NET WIB_SCL",
        "R104 PIN 2 NET MCU_SCL",
    ])
    component(canvas, "J1", 100, 250, 105, 120, [("1", "WIB_SCL"), ("2", "GND")])
    component(canvas, "R104", 345, 285, 82, 70, [("1", "WIB_SCL"), ("2", "MCU_SCL")])
    canvas.setLineWidth(1.4)
    canvas.line(205, 328, 345, 328)
    canvas.drawString(230, 336, "WIB_SCL")
    canvas.line(427, 313, 700, 313)
    canvas.drawString(500, 321, "TO_MCU_SCL")
    canvas.circle(460, 313, 3, fill=1)
    canvas.line(460, 313, 460, 230)
    canvas.line(460, 230, 590, 230)
    canvas.drawString(595, 227, "TEST_BRANCH")
    canvas.setFont("Helvetica", 9)
    canvas.drawString(34, 25, "PAGE 1 / PRODUCT INTERFACE")
    canvas.showPage()

    evidence_rows(canvas, "CONTROLLED PIN EVIDENCE", [
        "U7 PIN 36 NET MCU_SCL",
        "U7 PIN 12 NET GND",
    ])
    component(canvas, "U7", 460, 220, 150, 190, [("36", "MCU_SCL"), ("12", "GND")])
    canvas.setLineWidth(1.4)
    canvas.line(140, 368, 460, 368)
    canvas.drawString(150, 376, "FROM_MCU_SCL")
    canvas.line(140, 340, 460, 340)
    canvas.drawString(150, 348, "GND")
    canvas.setFont("Helvetica", 9)
    canvas.drawString(34, 25, "PAGE 2 / PRODUCT MCU")
    canvas.save()


def wib_pdf(path: Path) -> None:
    canvas = Canvas(str(path), pagesize=landscape(letter), pageCompression=0)
    canvas.setTitle("CircuitInspector WIB schematic fixture")
    evidence_rows(canvas, "CONTROLLED PIN EVIDENCE", [
        "P1 PIN 1 NET WIB_SCL",
        "P1 PIN 2 NET GND",
        "U2 PIN 5 NET WIB_SCL",
        "U2 PIN 8 NET GND",
    ])
    component(canvas, "P1", 100, 250, 105, 120, [("1", "WIB_SCL"), ("2", "GND")])
    component(canvas, "U2", 480, 220, 150, 190, [("5", "WIB_SCL"), ("8", "GND")])
    canvas.setLineWidth(1.4)
    canvas.line(205, 328, 480, 368)
    canvas.drawString(300, 360, "WIB_SCL")
    canvas.line(205, 300, 480, 340)
    canvas.drawString(300, 315, "GND")
    canvas.setFont("Helvetica", 9)
    canvas.drawString(34, 25, "PAGE 1 / WIB CONTROLLER")
    canvas.save()


def scanned_copy(source: Path, target: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="circuitinspector-scan-") as temporary:
        prefix = Path(temporary) / "page"
        subprocess.run([str(POPPLER), "-png", "-r", "144", str(source), str(prefix)], check=True)
        images: list[Image.Image] = []
        for page in sorted(Path(temporary).glob("page-*.png")):
            image = Image.open(page).convert("L")
            image = ImageEnhance.Contrast(image).enhance(0.88)
            image = image.filter(ImageFilter.GaussianBlur(radius=0.35)).convert("RGB")
            images.append(image)
        if not images:
            raise RuntimeError(f"No pages rendered from {source}")
        images[0].save(target, "PDF", resolution=144, save_all=True, append_images=images[1:])


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    product = FIXTURES / "product-schematic-vector.pdf"
    wib = FIXTURES / "wib-schematic-vector.pdf"
    product_pdf(product)
    wib_pdf(wib)
    scanned_copy(product, FIXTURES / "product-schematic-scanned.pdf")


if __name__ == "__main__":
    main()
