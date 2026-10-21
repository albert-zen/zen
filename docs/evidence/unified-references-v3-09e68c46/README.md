# Settled inline reference dialog evidence

Source: 09e68c4662f016214162cd8305211ee351cb0ff7
CI: https://github.com/albert-zen/zen/actions/runs/39553971807
Artifact: 12324209556

These actual Chrome screenshots wait for the dialog and overlay's finite entry animations to finish and assert opacity 1 before capture. They replace the excluded mid-animation frames from the preceding capture. Queue edit uses five inline synthetic references; the model dialog shows only the captured synthetic USER-message string, never system/tool prompts or full provider requests. Production code is unchanged from source 9770fd51; the followup changes only capture readiness. Desktop touch and OS clipboard limitations remain unchanged.
