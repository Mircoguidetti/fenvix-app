## fenvix: every skip checked

The whole suite was run again without the cache, at the same epoch, and `detjs verify` compared the two traces: status **diverged**. Of **5** tests, 4 identical, 0 NOT PROVEN, 1 diverged, 0 missing; of **0** results reused with proof, **wrong: 0**.

Diverged:
- `entropy.test.js::entropy::reads OS entropy` (entropy; outcomes ['passed', 'passed'])
