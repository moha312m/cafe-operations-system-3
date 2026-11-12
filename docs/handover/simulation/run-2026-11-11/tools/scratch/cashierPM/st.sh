for id in cmwcaxdba00rthljof1rm1jtn cmwcaxh8z00s5hljoc3rx4zjn cmwcaxhsg00sghljojtheh2f0 cmwcaxi8z00sshljomn71tdrp cmwcaxir000t3hljoi6dstv54 cmwcaxjav00tfhljor7bj318b; do
 $S call karim.pm@sim.test GET /api/orders/$id | grep -o '"orderNumber":[0-9]*\|"status":"[A-Z_]*"' | head -2 | tr '\n' ' '; echo; done
