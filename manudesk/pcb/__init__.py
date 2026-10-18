"""PCB stage, ported from Crusoe-Forge tc/pcb: an FPGA design's LPF -> HDMI/LED/button add-on board for the
ULX3S J1 header -> placed (by the agent or the hand template) -> Freerouting -> KiCad DRC gate -> fab outputs.

The coding agent is the placer: pcb_parts() tells it the parts, courtyards and nets, pcb_check() routes its
placement and returns the exact DRC violations to fix.
"""
from manudesk.pcb import pipeline
from manudesk.pcb.pipeline import PcbResult, check, parts

__all__ = ["PcbResult", "check", "parts", "pipeline"]
