# Bundled fonts

Every font in this directory is licensed under the **SIL Open Font License,
Version 1.1**. The full licence text is reproduced at the bottom of this file
and applies to all of them.

None of these fonts have been modified. They are the upstream `.woff2` builds,
renamed to `<family>-<weight>[i].woff2` so `css/novel.css` can reference them
predictably.

| File | Family | Copyright |
| --- | --- | --- |
| `opendyslexic-400.woff2`<br>`opendyslexic-700.woff2`<br>`opendyslexic-400i.woff2` | OpenDyslexic | Copyright (c) 2019-07-29, Abbie Gonzalez (https://abbiecod.es \| support@abbiecod.es), with Reserved Font Name OpenDyslexic. Copyright (c) 12/2012 - 2019 |
| `atkinson-400.woff2`<br>`atkinson-700.woff2`<br>`atkinson-400i.woff2` | Atkinson Hyperlegible | Copyright (c) 2020, Braille Institute of America, Inc. (https://brailleinstitute.org/freefont), with Reserved Font Name Atkinson Hyperlegible. |
| `literata-var.woff2`<br>`literata-var-italic.woff2` | Literata | Copyright (c) 2017, The Literata Project Authors (https://github.com/googlefonts/literata), with Reserved Font Name Literata. |

`literata-var*.woff2` are variable fonts covering weights 400–700 in a single
file; the others are static instances.

## Why these three

- **OpenDyslexic** weights the bottom of each letterform, which makes rotation
  and mirroring harder to confuse. It is the font most readers mean when they
  ask for a dyslexia-friendly option.
- **Atkinson Hyperlegible** was drawn by the Braille Institute to maximise
  distinction between characters that are easy to mistake for one another
  (`I l 1`, `O 0`, `b d p q`). It is the accessibility choice for low vision.
- **Literata** is a serif designed specifically for long-form screen reading,
  and it is a real improvement over the default system serif on Android.

The remaining typefaces in the reader (Serif, Sans, Mono) are system font
stacks and ship no files at all.

---

This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
