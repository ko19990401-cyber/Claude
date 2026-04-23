#!/usr/bin/env python3
"""Script to create LoGoChat department heads presentation."""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Cm
import copy

# Colors
MAIN_BLUE = RGBColor(0x1a, 0x56, 0xa0)
LIGHT_BLUE = RGBColor(0xe8, 0xf0, 0xfa)
DARK_BLUE = RGBColor(0x0d, 0x2d, 0x5e)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
GRAY = RGBColor(0x9E, 0x9E, 0x9E)
LIGHT_GRAY = RGBColor(0xF5, 0xF5, 0xF5)
DARK_GRAY = RGBColor(0x42, 0x42, 0x42)
ORANGE = RGBColor(0xFF, 0x8C, 0x00)
GREEN = RGBColor(0x2E, 0x7D, 0x32)
RED = RGBColor(0xC6, 0x28, 0x28)
YELLOW_BG = RGBColor(0xFF, 0xF9, 0xC4)
ACCOUNT_BLUE = RGBColor(0x21, 0x96, 0xF3)
ACCOUNT_GRAY = RGBColor(0xBD, 0xBD, 0xBD)

# Slide dimensions (widescreen 16:9)
SLIDE_W = Inches(13.33)
SLIDE_H = Inches(7.5)

prs = Presentation()
prs.slide_width = SLIDE_W
prs.slide_height = SLIDE_H

blank_layout = prs.slide_layouts[6]  # Blank layout


def add_slide():
    return prs.slides.add_slide(blank_layout)


def add_rect(slide, x, y, w, h, fill_color=None, line_color=None, line_width=None):
    shape = slide.shapes.add_shape(
        1,  # MSO_SHAPE_TYPE.RECTANGLE
        Inches(x), Inches(y), Inches(w), Inches(h)
    )
    if fill_color:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill_color
    else:
        shape.fill.background()
    if line_color:
        shape.line.color.rgb = line_color
        if line_width:
            shape.line.width = Pt(line_width)
    else:
        shape.line.fill.background()
    return shape


def add_text_box(slide, text, x, y, w, h, font_size=18, bold=False, color=None,
                 align=PP_ALIGN.LEFT, wrap=True, font_name="メイリオ"):
    txBox = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = txBox.text_frame
    tf.word_wrap = wrap
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(font_size)
    run.font.bold = bold
    run.font.name = font_name
    if color:
        run.font.color.rgb = color
    return txBox


def add_text_in_shape(shape, text, font_size=14, bold=False, color=None,
                      align=PP_ALIGN.CENTER, font_name="メイリオ"):
    tf = shape.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(font_size)
    run.font.bold = bold
    run.font.name = font_name
    if color:
        run.font.color.rgb = color


def add_footer(slide):
    """Add LoGoチャット footer to each slide."""
    footer_bg = add_rect(slide, 0, 7.1, 13.33, 0.4, fill_color=MAIN_BLUE)
    add_text_box(slide, "LoGoチャット", 0.2, 7.12, 2, 0.35,
                 font_size=9, color=WHITE, align=PP_ALIGN.LEFT)
    add_text_box(slide, "情報担当課", 11.0, 7.12, 2.0, 0.35,
                 font_size=9, color=WHITE, align=PP_ALIGN.RIGHT)


# ============================================================
# Slide 1: 表紙
# ============================================================
slide1 = add_slide()

# Background: full white
add_rect(slide1, 0, 0, 13.33, 7.5, fill_color=WHITE)

# Top accent bar
add_rect(slide1, 0, 0, 13.33, 0.15, fill_color=MAIN_BLUE)

# Main blue section (top area)
add_rect(slide1, 0, 0.15, 13.33, 3.5, fill_color=DARK_BLUE)

# Decorative circle elements
circ1 = slide1.shapes.add_shape(9, Inches(10.5), Inches(0.3), Inches(2.5), Inches(2.5))
circ1.fill.solid()
circ1.fill.fore_color.rgb = MAIN_BLUE
circ1.line.fill.background()

circ2 = slide1.shapes.add_shape(9, Inches(11.2), Inches(1.2), Inches(1.8), Inches(1.8))
circ2.fill.solid()
circ2.fill.fore_color.rgb = RGBColor(0x0d, 0x3f, 0x7a)
circ2.line.fill.background()

# LoGo badge
badge = add_rect(slide1, 0.5, 0.7, 1.8, 0.6, fill_color=MAIN_BLUE)
add_text_in_shape(badge, "LoGoチャット", font_size=12, bold=True, color=WHITE)

# Main title
add_text_box(slide1, "LoGoチャット\n試験運用のご案内", 0.5, 1.2, 9.5, 2.0,
             font_size=40, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Bottom white section
add_rect(slide1, 0, 3.65, 13.33, 3.45, fill_color=WHITE)

# Blue left accent bar
add_rect(slide1, 0.5, 3.9, 0.1, 2.0, fill_color=MAIN_BLUE)

# Subtitle
add_text_box(slide1, "各課からの担当者選出のお願い", 0.8, 3.85, 10, 0.8,
             font_size=22, bold=True, color=DARK_BLUE, align=PP_ALIGN.LEFT)

# Separator line
add_rect(slide1, 0.5, 4.7, 12.33, 0.03, fill_color=LIGHT_BLUE)

# Info grid
add_text_box(slide1, "令和8年4月", 0.8, 4.9, 5, 0.5,
             font_size=16, color=DARK_GRAY, align=PP_ALIGN.LEFT)
add_text_box(slide1, "情報担当課", 0.8, 5.5, 5, 0.5,
             font_size=16, color=DARK_GRAY, align=PP_ALIGN.LEFT)

# Bottom accent
add_rect(slide1, 0, 7.1, 13.33, 0.4, fill_color=MAIN_BLUE)
add_text_box(slide1, "LoGoチャット", 0.2, 7.12, 2, 0.35,
             font_size=9, color=WHITE, align=PP_ALIGN.LEFT)
add_text_box(slide1, "情報担当課", 11.0, 7.12, 2.0, 0.35,
             font_size=9, color=WHITE, align=PP_ALIGN.RIGHT)


# ============================================================
# Slide 2: LoGoチャットとは？
# ============================================================
slide2 = add_slide()
add_rect(slide2, 0, 0, 13.33, 7.5, fill_color=WHITE)

# Header
add_rect(slide2, 0, 0, 13.33, 1.1, fill_color=MAIN_BLUE)
add_text_box(slide2, "LoGoチャットとは？", 0.4, 0.15, 10, 0.75,
             font_size=28, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Card 1
card1_bg = add_rect(slide2, 0.4, 1.3, 5.9, 5.5, fill_color=LIGHT_BLUE)
card1_bg.line.color.rgb = MAIN_BLUE
card1_bg.line.width = Pt(1.5)

# Card 1 header
add_rect(slide2, 0.4, 1.3, 5.9, 0.7, fill_color=MAIN_BLUE)
add_text_box(slide2, "🏢  自治体職員専用のビジネスチャット", 0.55, 1.35, 5.6, 0.6,
             font_size=14, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Card 1 content
card1_content = [
    ("💬", "全国の自治体職員とチャットで繋がれる"),
    ("⚡", "メール・電話より迅速・気軽"),
    ("📎", "写真・位置情報・ファイルの共有が可能"),
]
for i, (icon, text) in enumerate(card1_content):
    y_pos = 2.15 + i * 1.4
    icon_bg = add_rect(slide2, 0.6, y_pos, 0.65, 0.65, fill_color=MAIN_BLUE)
    add_text_in_shape(icon_bg, icon, font_size=18, color=WHITE)
    add_text_box(slide2, text, 1.4, y_pos, 4.6, 0.65,
                 font_size=15, color=DARK_BLUE, align=PP_ALIGN.LEFT, bold=True)

# Card 2
card2_bg = add_rect(slide2, 7.0, 1.3, 5.9, 5.5, fill_color=LIGHT_BLUE)
card2_bg.line.color.rgb = MAIN_BLUE
card2_bg.line.width = Pt(1.5)

# Card 2 header
add_rect(slide2, 7.0, 1.3, 5.9, 0.7, fill_color=DARK_BLUE)
add_text_box(slide2, "📱  現場対応力の強化", 7.15, 1.35, 5.6, 0.6,
             font_size=14, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Card 2 content
card2_content = [
    ("📱", "スマートフォン（私用端末BYODも可）で使える"),
    ("📸", "現場写真や位置情報を即座に職場PCへ送信"),
    ("✅", "迅速な状況報告と指示が可能"),
]
for i, (icon, text) in enumerate(card2_content):
    y_pos = 2.15 + i * 1.4
    icon_bg = add_rect(slide2, 7.2, y_pos, 0.65, 0.65, fill_color=DARK_BLUE)
    add_text_in_shape(icon_bg, icon, font_size=18, color=WHITE)
    add_text_box(slide2, text, 8.0, y_pos, 4.6, 0.65,
                 font_size=15, color=DARK_BLUE, align=PP_ALIGN.LEFT, bold=True)

add_footer(slide2)


# ============================================================
# Slide 3: 今回の配布状況
# ============================================================
slide3 = add_slide()
add_rect(slide3, 0, 0, 13.33, 7.5, fill_color=WHITE)

# Header
add_rect(slide3, 0, 0, 13.33, 1.1, fill_color=MAIN_BLUE)
add_text_box(slide3, "今回の配布状況", 0.4, 0.15, 10, 0.75,
             font_size=28, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Title info
add_text_box(slide3, "全アカウント数：10個", 0.4, 1.25, 5, 0.5,
             font_size=18, bold=True, color=DARK_BLUE, align=PP_ALIGN.LEFT)

# Account visualization - 10 circles
# Row of 10 circles
circle_configs = [
    (ACCOUNT_GRAY, "管理者"),     # 1: admin
    (ACCOUNT_GRAY, "情報担当"),   # 2: info
    (ACCOUNT_BLUE, "総務課①"),   # 3
    (ACCOUNT_BLUE, "総務課②"),   # 4
    (ACCOUNT_BLUE, "企画商工"),   # 5
    (ACCOUNT_BLUE, "農務課"),     # 6
    (ACCOUNT_BLUE, "建設水道"),   # 7
    (ACCOUNT_BLUE, "住民生活"),   # 8
    (ACCOUNT_BLUE, "保健福祉"),   # 9
    (ACCOUNT_BLUE, "教育委員会"), # 10
]

circle_r = 0.65
start_x = 0.5
start_y = 1.9
spacing_x = 1.22

for i, (color, label) in enumerate(circle_configs):
    cx = start_x + i * spacing_x
    circ = slide3.shapes.add_shape(9, Inches(cx), Inches(start_y), Inches(circle_r), Inches(circle_r))
    circ.fill.solid()
    circ.fill.fore_color.rgb = color
    circ.line.fill.background()
    # Number inside circle
    tf = circ.text_frame
    tf.word_wrap = False
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = str(i + 1)
    run.font.size = Pt(18)
    run.font.bold = True
    run.font.name = "メイリオ"
    run.font.color.rgb = WHITE
    # Label below
    add_text_box(slide3, label, cx - 0.1, start_y + 0.7, circle_r + 0.2, 0.4,
                 font_size=9, color=DARK_GRAY, align=PP_ALIGN.CENTER)

# Legend
legend_y = 3.4
add_rect(slide3, 0.5, legend_y, 0.35, 0.3, fill_color=ACCOUNT_GRAY)
add_text_box(slide3, "管理者アカウント：1個", 1.0, legend_y - 0.02, 4, 0.35,
             font_size=13, color=DARK_GRAY, align=PP_ALIGN.LEFT)

add_rect(slide3, 0.5, legend_y + 0.45, 0.35, 0.3, fill_color=ACCOUNT_GRAY)
add_text_box(slide3, "情報担当課：1個", 1.0, legend_y + 0.43, 4, 0.35,
             font_size=13, color=DARK_GRAY, align=PP_ALIGN.LEFT)

add_rect(slide3, 0.5, legend_y + 0.9, 0.35, 0.3, fill_color=ACCOUNT_BLUE)
add_text_box(slide3, "各課への配布：8個  ← 今回の対象", 1.0, legend_y + 0.88, 6, 0.35,
             font_size=14, bold=True, color=MAIN_BLUE, align=PP_ALIGN.LEFT)

# Target section
add_rect(slide3, 0.4, 4.65, 12.5, 2.1, fill_color=LIGHT_BLUE)
target_border = add_rect(slide3, 0.4, 4.65, 12.5, 2.1)
target_border.fill.background()
target_border.line.color.rgb = MAIN_BLUE
target_border.line.width = Pt(1.5)

add_text_box(slide3, "まずは以下の課を対象に試験運用し、効果を検証します", 0.6, 4.7, 12, 0.5,
             font_size=14, bold=True, color=DARK_BLUE, align=PP_ALIGN.LEFT)

course_list = [
    "総務課（2アカウント）", "企画商工観光課", "農務課", "建設水道課",
    "住民生活課", "保健福祉課", "教育委員会"
]
cols = 4
for i, course in enumerate(course_list):
    col = i % cols
    row = i // cols
    x = 0.7 + col * 3.1
    y = 5.25 + row * 0.6
    bullet_bg = add_rect(slide3, x, y + 0.08, 0.12, 0.28, fill_color=ACCOUNT_BLUE)
    add_text_box(slide3, course, x + 0.25, y, 2.8, 0.45,
                 font_size=13, color=DARK_BLUE, align=PP_ALIGN.LEFT)

add_footer(slide3)


# ============================================================
# Slide 4: 選出していただきたい職員
# ============================================================
slide4 = add_slide()
add_rect(slide4, 0, 0, 13.33, 7.5, fill_color=WHITE)

# Header
add_rect(slide4, 0, 0, 13.33, 1.1, fill_color=MAIN_BLUE)
add_text_box(slide4, "選出していただきたい職員", 0.4, 0.15, 10, 0.75,
             font_size=28, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Pattern A card
cardA_bg = add_rect(slide4, 0.4, 1.25, 5.9, 5.0, fill_color=LIGHT_BLUE)
cardA_bg.line.color.rgb = MAIN_BLUE
cardA_bg.line.width = Pt(2)

add_rect(slide4, 0.4, 1.25, 5.9, 0.75, fill_color=MAIN_BLUE)
add_text_box(slide4, "パターン A", 0.55, 1.3, 5.6, 0.6,
             font_size=15, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Big icon for Pattern A
icon_A = slide4.shapes.add_shape(9, Inches(3.2), Inches(2.1), Inches(1.0), Inches(1.0))
icon_A.fill.solid()
icon_A.fill.fore_color.rgb = MAIN_BLUE
icon_A.line.fill.background()
tf = icon_A.text_frame
p = tf.paragraphs[0]
p.alignment = PP_ALIGN.CENTER
run = p.add_run()
run.text = "🏛️"
run.font.size = Pt(28)

add_text_box(slide4, "外部連携が多い方", 0.55, 3.2, 5.6, 0.5,
             font_size=18, bold=True, color=DARK_BLUE, align=PP_ALIGN.CENTER)

pA_items = [
    "他の自治体の職員と頻繁にやりとりする方",
    "メールや電話のやりとりを効率化できます",
    "例）広域連携業務、国・県との調整業務 など",
]
for i, item in enumerate(pA_items):
    y = 3.8 + i * 0.62
    bullet = add_rect(slide4, 0.6, y + 0.1, 0.12, 0.28, fill_color=MAIN_BLUE)
    add_text_box(slide4, item, 0.85, y, 5.2, 0.55,
                 font_size=13, color=DARK_GRAY, align=PP_ALIGN.LEFT)

# Pattern B card
cardB_bg = add_rect(slide4, 7.0, 1.25, 5.9, 5.0, fill_color=LIGHT_BLUE)
cardB_bg.line.color.rgb = DARK_BLUE
cardB_bg.line.width = Pt(2)

add_rect(slide4, 7.0, 1.25, 5.9, 0.75, fill_color=DARK_BLUE)
add_text_box(slide4, "パターン B", 7.15, 1.3, 5.6, 0.6,
             font_size=15, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Big icon for Pattern B
icon_B = slide4.shapes.add_shape(9, Inches(9.8), Inches(2.1), Inches(1.0), Inches(1.0))
icon_B.fill.solid()
icon_B.fill.fore_color.rgb = DARK_BLUE
icon_B.line.fill.background()
tf = icon_B.text_frame
p = tf.paragraphs[0]
p.alignment = PP_ALIGN.CENTER
run = p.add_run()
run.text = "📸"
run.font.size = Pt(28)

add_text_box(slide4, "現場作業が多い方", 7.15, 3.2, 5.6, 0.5,
             font_size=18, bold=True, color=DARK_BLUE, align=PP_ALIGN.CENTER)

pB_items = [
    "現場での仕事が多い方",
    "写真・位置情報をリアルタイムで\n職場のPCに送りたい方",
    "例）道路・施設管理、農林業務、福祉訪問 など",
]
for i, item in enumerate(pB_items):
    y = 3.8 + i * 0.62
    bullet = add_rect(slide4, 7.2, y + 0.1, 0.12, 0.28, fill_color=DARK_BLUE)
    add_text_box(slide4, item, 7.45, y, 5.2, 0.55,
                 font_size=13, color=DARK_GRAY, align=PP_ALIGN.LEFT)

# Notice box at bottom
notice_bg = add_rect(slide4, 0.4, 6.35, 12.5, 0.65, fill_color=YELLOW_BG)
notice_bg.line.color.rgb = ORANGE
notice_bg.line.width = Pt(1.5)
add_text_box(slide4, "⚠ どちらにも当てはまらない場合は、情報担当課へご相談ください", 0.6, 6.42, 12, 0.5,
             font_size=14, bold=True, color=RGBColor(0x7B, 0x45, 0x00), align=PP_ALIGN.CENTER)

add_footer(slide4)


# ============================================================
# Slide 5: 10アカウントでできること・できないこと
# ============================================================
slide5 = add_slide()
add_rect(slide5, 0, 0, 13.33, 7.5, fill_color=WHITE)

# Header
add_rect(slide5, 0, 0, 13.33, 1.1, fill_color=MAIN_BLUE)
add_text_box(slide5, "10アカウントでできること・できないこと", 0.4, 0.15, 11, 0.75,
             font_size=26, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Table
table_data = [
    ("", "内容", "今回できる？"),
    ("✅", "他自治体職員との個別チャット", "できる"),
    ("✅", "現場写真・位置情報の送信", "できる"),
    ("✅", "LoGoチャットUG（全国コミュニティ）への参加", "できる"),
    ("⚠️", "庁内職員間のコミュニケーションツールとして活用", "限定的※"),
    ("❌", "全庁的な情報共有・一斉連絡", "今回は対象外"),
]

row_heights = [0.55, 0.8, 0.8, 0.8, 0.8, 0.8]
col_widths = [0.8, 8.5, 2.5]
col_x = [0.3, 1.2, 9.8]
start_y = 1.2

header_colors = [MAIN_BLUE, MAIN_BLUE, MAIN_BLUE]
row_colors = [
    [LIGHT_GRAY, LIGHT_GRAY, LIGHT_GRAY],
    [RGBColor(0xE8, 0xF5, 0xE9), RGBColor(0xE8, 0xF5, 0xE9), RGBColor(0xE8, 0xF5, 0xE9)],
    [RGBColor(0xE8, 0xF5, 0xE9), RGBColor(0xE8, 0xF5, 0xE9), RGBColor(0xE8, 0xF5, 0xE9)],
    [RGBColor(0xE8, 0xF5, 0xE9), RGBColor(0xE8, 0xF5, 0xE9), RGBColor(0xE8, 0xF5, 0xE9)],
    [RGBColor(0xFF, 0xFD, 0xE7), RGBColor(0xFF, 0xFD, 0xE7), RGBColor(0xFF, 0xFD, 0xE7)],
    [RGBColor(0xFF, 0xEB, 0xEE), RGBColor(0xFF, 0xEB, 0xEE), RGBColor(0xFF, 0xEB, 0xEE)],
]
text_colors = [
    [WHITE, WHITE, WHITE],
    [GREEN, DARK_GRAY, GREEN],
    [GREEN, DARK_GRAY, GREEN],
    [GREEN, DARK_GRAY, GREEN],
    [ORANGE, DARK_GRAY, ORANGE],
    [RED, DARK_GRAY, RED],
]
font_sizes = [
    [14, 15, 15],
    [20, 15, 15],
    [20, 15, 15],
    [20, 15, 15],
    [18, 15, 15],
    [18, 15, 15],
]

curr_y = start_y
for row_i, (row_data, rh) in enumerate(zip(table_data, row_heights)):
    for col_i, (cell_text, cw, cx) in enumerate(zip(row_data, col_widths, col_x)):
        if row_i == 0:
            bg = add_rect(slide5, cx, curr_y, cw, rh, fill_color=MAIN_BLUE)
            txt_color = WHITE
            bold = True
            fs = 15
        else:
            bg = add_rect(slide5, cx, curr_y, cw, rh, fill_color=row_colors[row_i][col_i])
            txt_color = text_colors[row_i][col_i]
            bold = (col_i == 2)
            fs = font_sizes[row_i][col_i]
        bg.line.color.rgb = RGBColor(0xBB, 0xDE, 0xFB)
        bg.line.width = Pt(0.75)
        if row_i == 0:
            add_text_box(slide5, cell_text, cx + 0.05, curr_y + 0.1, cw - 0.1, rh - 0.1,
                         font_size=fs, bold=True, color=txt_color, align=PP_ALIGN.CENTER)
        else:
            align = PP_ALIGN.CENTER if col_i != 1 else PP_ALIGN.LEFT
            add_text_box(slide5, cell_text, cx + 0.1, curr_y + 0.12, cw - 0.15, rh - 0.1,
                         font_size=fs, bold=bold, color=txt_color, align=align)
    curr_y += rh

# Note at bottom
note_bg = add_rect(slide5, 0.3, 6.15, 12.7, 0.8, fill_color=LIGHT_GRAY)
add_text_box(slide5, "※10アカウントでは庁内チャットの恩恵は限られます。まずは外部連携・現場活用での効果を検証します。全庁展開はその結果をふまえて検討します。",
             0.5, 6.2, 12.4, 0.7, font_size=11, color=DARK_GRAY, align=PP_ALIGN.LEFT)

add_footer(slide5)


# ============================================================
# Slide 6: お願いと今後の流れ
# ============================================================
slide6 = add_slide()
add_rect(slide6, 0, 0, 13.33, 7.5, fill_color=WHITE)

# Header
add_rect(slide6, 0, 0, 13.33, 1.1, fill_color=MAIN_BLUE)
add_text_box(slide6, "お願いと今後の流れ", 0.4, 0.15, 10, 0.75,
             font_size=28, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

# Flow steps
steps = [
    ("STEP 1", "担当者の選出", "5月29日まで", "各課から1名、情報担当課へご連絡ください"),
    ("STEP 2", "アカウントの発行・説明", "6月", "情報担当課より個別にご連絡します"),
    ("STEP 3", "試験運用開始", "6月〜", "実際に使ってみて、課題・効果をご報告ください"),
    ("STEP 4", "全庁展開の検討", "来年度", "検証結果をもとに継続・拡大を判断します"),
]

step_colors = [MAIN_BLUE, DARK_BLUE, RGBColor(0x15, 0x65, 0xC0), RGBColor(0x0D, 0x47, 0xA1)]
box_w = 2.8
box_h = 3.8
start_x = 0.4
gap = 0.15
arrow_w = 0.35

for i, (step_label, title, period, desc) in enumerate(steps):
    bx = start_x + i * (box_w + gap + arrow_w)

    # Step box
    step_card = add_rect(slide6, bx, 1.3, box_w, box_h, fill_color=WHITE)
    step_card.line.color.rgb = step_colors[i]
    step_card.line.width = Pt(2)

    # Step header
    add_rect(slide6, bx, 1.3, box_w, 0.65, fill_color=step_colors[i])
    add_text_box(slide6, step_label, bx + 0.05, 1.35, box_w - 0.1, 0.55,
                 font_size=16, bold=True, color=WHITE, align=PP_ALIGN.CENTER)

    # Period badge
    period_bg = add_rect(slide6, bx + 0.15, 2.05, box_w - 0.3, 0.45, fill_color=LIGHT_BLUE)
    add_text_box(slide6, period, bx + 0.15, 2.07, box_w - 0.3, 0.4,
                 font_size=14, bold=True, color=step_colors[i], align=PP_ALIGN.CENTER)

    # Title
    add_text_box(slide6, title, bx + 0.1, 2.6, box_w - 0.2, 0.65,
                 font_size=16, bold=True, color=step_colors[i], align=PP_ALIGN.CENTER)

    # Description
    add_text_box(slide6, desc, bx + 0.15, 3.35, box_w - 0.3, 1.6,
                 font_size=13, color=DARK_GRAY, align=PP_ALIGN.LEFT)

    # Arrow between steps
    if i < 3:
        arrow_x = bx + box_w + 0.02
        arrow_y = 1.3 + box_h / 2 - 0.25
        arrow = slide6.shapes.add_shape(13, Inches(arrow_x), Inches(arrow_y),
                                        Inches(arrow_w), Inches(0.5))
        arrow.fill.solid()
        arrow.fill.fore_color.rgb = MAIN_BLUE
        arrow.line.fill.background()

# Contact box
contact_bg = add_rect(slide6, 0.4, 5.5, 12.5, 1.3, fill_color=LIGHT_BLUE)
contact_bg.line.color.rgb = MAIN_BLUE
contact_bg.line.width = Pt(2)

add_text_box(slide6, "📞  ご質問・ご相談は", 0.7, 5.55, 3, 0.45,
             font_size=13, color=DARK_GRAY, align=PP_ALIGN.LEFT)
add_text_box(slide6, "総務課総務グループ 情報防災係 まで", 0.7, 6.0, 10, 0.6,
             font_size=18, bold=True, color=DARK_BLUE, align=PP_ALIGN.LEFT)

add_footer(slide6)


# ============================================================
# Save
# ============================================================
import os
os.makedirs("/mnt/user-data/outputs", exist_ok=True)
output_path = "/mnt/user-data/outputs/logochat_department_heads.pptx"
prs.save(output_path)
print(f"Saved: {output_path}")
