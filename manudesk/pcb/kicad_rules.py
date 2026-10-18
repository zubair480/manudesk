"""Board design rules, shared by kicad_gen.py and kicad_ses.py (both run inside KiCad's Python).

KiCad keeps these in the board's .kicad_pro. Where SaveBoard writes no project for a fresh board (KiCad on
Linux), LoadBoard falls back to the defaults (0.2 mm track/clearance) and DRC then flags every 0.15 mm
Freerouting track, so kicad_ses.py applies them again after loading.
"""
import pcbnew


def apply_rules(board) -> None:
    ds = board.GetDesignSettings()
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(pcbnew.FromMM(0.2)); nc.SetClearance(pcbnew.FromMM(0.15))
    nc.SetViaDiameter(pcbnew.FromMM(0.6)); nc.SetViaDrill(pcbnew.FromMM(0.3))
    ds.m_MinClearance = pcbnew.FromMM(0.15)
    ds.m_TrackMinWidth = pcbnew.FromMM(0.15)
