import sys, re
p = sys.argv[1]; txt = open(p).read()
# Merge under the EXISTING platform_toolsets key (a second key is a YAML duplicate and hermes ignores the whole file).
m = re.search(r'^platform_toolsets:[ \t]*(\{\}[ \t]*)?$', txt, re.M)
block = "platform_toolsets:\n  parley:\n    - hermes-parley\n    - parley\n"
if m:
    txt = txt[:m.start()] + block + txt[m.end():].lstrip("\n")
else:
    txt += "\n" + block
open(p, "w").write(txt); print("toolsets merged (existing key: %s)" % bool(m))
