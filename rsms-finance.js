/* ═══════════════════════════════════════════════════════════════
   RSMS FINANCE ENGINE — FIND
   Finance records are local-first cached collections synchronized through
   RSMS_FB. Payments are an append-only ledger; status changes are audited.
═══════════════════════════════════════════════════════════════ */

(function(window){
  'use strict';

  var FINANCE_KEYS = [
    'fee_structures','student_fees','payments','recurring',
    'recurring_schedule','expenses','wallet','audit_log'
  ];
  var _syncHandlers = [];
  var _initialised = false;

  function safeParse(raw, fallback){
    try { return raw ? JSON.parse(raw) : fallback; }
    catch(e){ return fallback; }
  }

  function asArray(value){
    if(Array.isArray(value)) return value.filter(Boolean);
    if(value && typeof value === 'object'){
      return Object.keys(value).map(function(key){ return value[key]; }).filter(Boolean);
    }
    return [];
  }

  function copy(value){
    try { return JSON.parse(JSON.stringify(value)); }
    catch(e){ return value; }
  }

  function number(value){
    var parsed = parseFloat(value);
    return isFinite(parsed) ? parsed : 0;
  }

  function money(value){
    return Math.round(number(value) * 100) / 100;
  }

  function school(){
    return safeParse(localStorage.getItem('rsms_school'), {
      term:'First Term', session:'2025/2026'
    }) || {};
  }

  function schoolId(){
    return school().schoolId || '';
  }

  function scopedKey(key){
    var sid = schoolId();
    return sid ? 'rsms_'+sid+'_'+key : 'rsms_'+key;
  }

  function readCollection(key){
    var sid = schoolId();
    var raw = sid ? localStorage.getItem('rsms_'+sid+'_'+key) : null;
    if(!raw) raw = localStorage.getItem('rsms_'+key);
    return asArray(safeParse(raw, []));
  }

  function localSave(key, data){
    var json = JSON.stringify(data);
    var sid = schoolId();
    try { localStorage.setItem('rsms_'+key, json); } catch(e){}
    if(sid){
      try { localStorage.setItem('rsms_'+sid+'_'+key, json); } catch(e2){}
    }
  }

  function emitSync(key, data){
    _syncHandlers.slice().forEach(function(handler){
      try { handler(key, data); } catch(e){}
    });
  }

  function saveCollection(key, data){
    var value = asArray(data);
    localSave(key, value);
    try{
      if(window.RSMS_FB && typeof window.RSMS_FB.saveCollection === 'function'){
        window.RSMS_FB.saveCollection(key, value);
      }
    }catch(e){}
    emitSync(key, value);
    return value;
  }

  function saveLegacyFees(data){
    var value = asArray(data);
    localSave('fees', value);
    try{
      if(window.RSMS_FB && typeof window.RSMS_FB.saveFees === 'function'){
        window.RSMS_FB.saveFees(value);
      }else if(window.RSMS_FB && typeof window.RSMS_FB.saveCollection === 'function'){
        window.RSMS_FB.saveCollection('fees', value);
      }
    }catch(e){}
    emitSync('fees', value);
    return value;
  }

  function currentTerm(value){
    return value || school().term || 'First Term';
  }

  function currentSession(value){
    return value || school().session || '2025/2026';
  }

  function termNumber(term){
    var value = String(term || '').toLowerCase();
    if(value.indexOf('second') > -1 || value === '2') return 2;
    if(value.indexOf('third') > -1 || value === '3') return 3;
    return 1;
  }

  function recordYear(date){
    var match = String(date || '').match(/^(\d{4})/);
    return match ? match[1] : String(new Date().getFullYear());
  }

  function today(){
    return new Date().toISOString().slice(0,10);
  }

  function now(){
    return new Date().toISOString();
  }

  function id(prefix){
    return (prefix || 'id')+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  }

  function studentName(student){
    if(!student) return 'Unknown Student';
    if(student.name) return student.name;
    return ((student.surname || '')+' '+(student.firstname || '')).replace(/^\s+|\s+$/g,'') || student.student || 'Unknown Student';
  }

  function students(){
    var sid = schoolId();
    var raw = sid ? localStorage.getItem('rsms_'+sid+'_students') : null;
    if(!raw) raw = localStorage.getItem('rsms_students');
    return asArray(safeParse(raw, []));
  }

  function studentFor(stuId){
    var found = null;
    students().some(function(student){
      if(String(student.id || student.stuId || '') === String(stuId || '')){
        found = student;
        return true;
      }
      return false;
    });
    return found;
  }

  function userName(){
    var user = safeParse(sessionStorage.getItem('rsms_user'), {}) || {};
    return user.name || user.email || user.role || 'Bursar';
  }

  function sameContext(record, term, session){
    return (record.term || currentTerm()) === term && (record.session || currentSession()) === session;
  }

  function isPaidStatus(status){
    return status === 'Paid' || status === 'Partially Paid';
  }

  function audit(action, type, details, before, after){
    var entry;
    if(typeof window.logAudit === 'function'){
      window.logAudit(action, type, details, before || null, after || null);
      return;
    }
    entry = {
      id:'a-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),
      action:action,
      type:type,
      details:details,
      before:before || null,
      after:after || null,
      timestamp:now(),
      date:today(),
      time:new Date().toLocaleTimeString(),
      user:userName()
    };
    var log = readCollection('audit_log');
    log.push(entry);
    saveCollection('audit_log', log);
  }

  function getFeeStructure(className, term, session){
    term = currentTerm(term);
    session = currentSession(session);
    var found = null;
    readCollection('fee_structures').some(function(structure){
      if(structure.class === className && sameContext(structure, term, session)){
        found = copy(structure);
        return true;
      }
      return false;
    });
    return found || {class:className || '', term:term, session:session, items:[]};
  }

  function saveFeeStructure(structure){
    var item = structure || {};
    var term = currentTerm(item.term);
    var session = currentSession(item.session);
    var record = {
      id:item.id || id('fee-structure'),
      class:item.class || '',
      term:term,
      session:session,
      items:asArray(item.items).map(function(row){
        return {
          id:row.id || id('fee-item'),
          type:row.type || row.label || 'Fee item',
          amount:money(row.amount)
        };
      }),
      updatedAt:now()
    };
    var all = readCollection('fee_structures');
    var found = false;
    all = all.map(function(row){
      if(row.class === record.class && sameContext(row, term, session)){
        found = true;
        record.id = row.id || record.id;
        return record;
      }
      return row;
    });
    if(!found) all.push(record);
    saveCollection('fee_structures', all);
    audit('Fee structure saved', 'fee_structure', 'Updated '+record.class+' fees for '+term+' '+session, null, record);
    return copy(record);
  }

  function classTotal(className, term, session){
    return getFeeStructure(className, term, session).items.reduce(function(total, item){
      return total + money(item.amount);
    }, 0);
  }

  function getStudentFees(stuId, term, session){
    term = currentTerm(term);
    session = currentSession(session);
    var found = null;
    readCollection('student_fees').some(function(record){
      if(String(record.stuId || '') === String(stuId || '') && sameContext(record, term, session)){
        found = copy(record);
        return true;
      }
      return false;
    });
    var student = studentFor(stuId) || {};
    return found || {
      id:'', stuId:stuId || '', student:studentName(student), class:student.class || '',
      term:term, session:session, charges:[], discounts:[]
    };
  }

  function saveStudentFees(data){
    var input = data || {};
    var term = currentTerm(input.term);
    var session = currentSession(input.session);
    var student = studentFor(input.stuId) || {};
    var record = {
      id:input.id || id('student-fee'),
      stuId:input.stuId || '',
      student:input.student || studentName(student),
      class:input.class || student.class || '',
      term:term,
      session:session,
      charges:asArray(input.charges).map(function(row){
        return {id:row.id || id('charge'), label:row.label || 'Additional charge', amount:money(row.amount)};
      }),
      discounts:asArray(input.discounts).map(function(row){
        return {id:row.id || id('discount'), label:row.label || 'Discount', amount:money(row.amount)};
      }),
      updatedAt:now()
    };
    var all = readCollection('student_fees');
    var found = false;
    all = all.map(function(row){
      if(String(row.stuId || '') === String(record.stuId) && sameContext(row, term, session)){
        found = true;
        record.id = row.id || record.id;
        return record;
      }
      return row;
    });
    if(!found) all.push(record);
    saveCollection('student_fees', all);
    audit('Student fee adjustment saved', 'fee_adjustment', 'Updated charges and discounts for '+record.student, null, record);
    return copy(record);
  }

  function addStudentAdjustment(stuId, kind, label, amount, term, session){
    var record = getStudentFees(stuId, term, session);
    var key = kind === 'discount' || kind === 'discounts' ? 'discounts' : 'charges';
    var value = money(amount);
    if(value <= 0) throw new Error('Enter an amount greater than zero.');
    record[key].push({
      id:id(key === 'charges' ? 'charge' : 'discount'),
      label:label || (key === 'charges' ? 'Additional charge' : 'Discount'),
      amount:value
    });
    return saveStudentFees(record);
  }

  function removeStudentAdjustment(stuId, kind, adjustmentId, term, session){
    var record = getStudentFees(stuId, term, session);
    var key = kind === 'discount' || kind === 'discounts' ? 'discounts' : 'charges';
    record[key] = record[key].filter(function(row){ return row.id !== adjustmentId; });
    return saveStudentFees(record);
  }

  function studentPayable(stuOrId, term, session){
    var student = typeof stuOrId === 'object' ? stuOrId : studentFor(stuOrId);
    var stuId = typeof stuOrId === 'object' ? (stuOrId.id || stuOrId.stuId) : stuOrId;
    if(!student) return 0;
    term = currentTerm(term);
    session = currentSession(session);
    var adjustment = getStudentFees(stuId, term, session);
    var charges = adjustment.charges.reduce(function(total, row){ return total + money(row.amount); }, 0);
    var discounts = adjustment.discounts.reduce(function(total, row){ return total + money(row.amount); }, 0);
    return Math.max(0, money(classTotal(student.class || '', term, session) + charges - discounts));
  }

  function paidFor(stuOrId, term, session){
    var stuId = typeof stuOrId === 'object' ? (stuOrId.id || stuOrId.stuId) : stuOrId;
    term = currentTerm(term);
    session = currentSession(session);
    return readCollection('payments').filter(function(payment){
      return String(payment.stuId || '') === String(stuId || '') &&
        sameContext(payment, term, session) && isPaidStatus(payment.status);
    }).reduce(function(total, payment){
      return total + money(payment.amount);
    }, 0);
  }

  function paymentStatusFor(payable, paid){
    if(payable <= 0) return paid > 0 ? 'Paid' : 'No fee set';
    if(paid >= payable) return 'Paid';
    if(paid > 0) return 'Partially Paid';
    return 'Unpaid';
  }

  function termStats(term, session){
    if(term && typeof term === 'object'){
      session = term.session;
      term = term.term;
    }
    term = currentTerm(term);
    session = currentSession(session);
    var allStudents = students();
    var rows = allStudents.map(function(student){
      var payable = studentPayable(student, term, session);
      var paid = paidFor(student, term, session);
      var outstanding = Math.max(0, money(payable - paid));
      return {
        stuId:student.id || student.stuId || '',
        student:studentName(student),
        class:student.class || 'Unassigned',
        reg:student.reg || student.registrationNo || '',
        payable:payable,
        paid:paid,
        outstanding:outstanding,
        status:paymentStatusFor(payable, paid)
      };
    });
    var projected = rows.reduce(function(total, row){ return total + row.payable; }, 0);
    var collected = rows.reduce(function(total, row){ return total + row.paid; }, 0);
    var outstanding = rows.reduce(function(total, row){ return total + row.outstanding; }, 0);
    var byClass = {};
    rows.forEach(function(row){
      if(!byClass[row.class]){
        byClass[row.class] = {
          class:row.class, students:0, paid:0, unpaid:0,
          expected:0, collected:0, outstanding:0, feeAvg:0
        };
      }
      var bucket = byClass[row.class];
      bucket.students++;
      bucket.expected += row.payable;
      bucket.collected += row.paid;
      bucket.outstanding += row.outstanding;
      if(row.status === 'Paid') bucket.paid++;
      else if(row.payable > 0) bucket.unpaid++;
    });
    readCollection('fee_structures').forEach(function(structure){
      if(sameContext(structure, term, session) && structure.class && !byClass[structure.class]){
        byClass[structure.class] = {
          class:structure.class, students:0, paid:0, unpaid:0,
          expected:0, collected:0, outstanding:0, feeAvg:0
        };
      }
    });
    var classes = Object.keys(byClass).sort().map(function(className){
      var bucket = byClass[className];
      bucket.feeAvg = bucket.students ? money(bucket.expected / bucket.students) : classTotal(className, term, session);
      bucket.expected = money(bucket.expected);
      bucket.collected = money(bucket.collected);
      bucket.outstanding = money(bucket.outstanding);
      return bucket;
    });
    var topUnpaid = rows.filter(function(row){ return row.outstanding > 0; }).sort(function(a,b){
      return b.outstanding - a.outstanding;
    }).slice(0,5);
    var feeStudents = rows.filter(function(row){ return row.payable > 0; });
    return {
      term:term,
      session:session,
      projected:money(projected),
      collected:money(collected),
      outstanding:money(outstanding),
      avgFee:rows.length ? money(projected / rows.length) : 0,
      collectionRate:projected ? money((collected / projected) * 100) : 0,
      paidStudents:rows.filter(function(row){ return row.status === 'Paid' && row.payable > 0; }).length,
      unpaidStudents:rows.filter(function(row){ return row.payable > 0 && row.status !== 'Paid'; }).length,
      students:rows.length,
      feeStudents:feeStudents.length,
      rows:rows,
      classes:classes,
      perClass:classes,
      topUnpaid:topUnpaid
    };
  }

  function nextSequence(prefix, year, term){
    var highest = 0;
    readCollection('payments').forEach(function(payment){
      var value = payment[prefix] || '';
      var pattern = prefix === 'txId' ? 'TX/'+year+'/'+term+'/' : 'RCP/'+year+'/'+term+'/';
      if(value.indexOf(pattern) === 0){
        var seq = parseInt(value.split('/').pop(), 10);
        if(seq > highest) highest = seq;
      }
    });
    return highest + 1;
  }

  function legacyMirror(payment){
    var fees = readCollection('fees');
    var found = null;
    fees.some(function(fee){
      if((fee.txId && fee.txId === payment.txId) ||
        (fee.receiptNo && fee.receiptNo === payment.receiptNo)){
        found = fee;
        return true;
      }
      return false;
    });
    if(found) return found;
    var legacy = {
      id:'f-'+payment.id,
      txId:payment.txId,
      receiptNo:payment.receiptNo,
      stuId:payment.stuId,
      student:payment.student,
      class:payment.class,
      reg:payment.reg,
      type:payment.type,
      amount:payment.amount,
      method:payment.method,
      date:payment.date,
      ref:payment.ref,
      term:payment.term,
      session:payment.session,
      recordedAt:payment.recordedAt,
      channel:payment.channel,
      status:payment.status
    };
    fees.push(legacy);
    saveLegacyFees(fees);
    return legacy;
  }

  function pay(options){
    options = options || {};
    var amount = money(options.amount);
    if(!options.stuId) throw new Error('A student is required to record a payment.');
    if(amount <= 0) throw new Error('Enter an amount greater than zero.');
    var paymentDate = options.date || today();
    var year = recordYear(paymentDate);
    var term = currentTerm(options.term);
    var session = currentSession(options.session);
    var termNo = termNumber(term);
    var student = studentFor(options.stuId) || {};
    var payments = readCollection('payments');
    var txSequence = nextSequence('txId', year, termNo);
    var receiptSequence = nextSequence('receiptNo', year, termNo);
    var txId = options.txId || 'TX/'+year+'/'+termNo+'/'+String(txSequence).padStart(5,'0');
    var receiptNo = options.receiptNo || 'RCP/'+year+'/'+termNo+'/'+String(receiptSequence).padStart(5,'0');
    var existing = null;
    payments.some(function(row){
      if(row.txId === txId){ existing = row; return true; }
      return false;
    });
    if(existing) return copy(existing);
    var payment = {
      id:options.id || id('payment'),
      txId:txId,
      receiptNo:receiptNo,
      stuId:options.stuId,
      student:options.student || studentName(student),
      class:options.class || student.class || '--',
      reg:options.reg || student.reg || student.registrationNo || '--',
      amount:amount,
      type:options.type || 'School Fees',
      method:options.method || 'Cash',
      channel:options.channel || 'bursar',
      ref:options.ref || '',
      status:options.status || 'Paid',
      term:term,
      session:session,
      by:options.by || userName(),
      date:paymentDate,
      recordedAt:options.recordedAt || now(),
      source:options.source || 'finance',
      note:options.note || ''
    };
    payments.push(payment);
    saveCollection('payments', payments);
    if(isPaidStatus(payment.status)) legacyMirror(payment);
    audit('Payment recorded', 'fee_payment', 'Payment '+payment.txId+': none → '+payment.status, null, payment);
    return copy(payment);
  }

  function setPaymentStatus(txId, status, note){
    var payments = readCollection('payments');
    var before = null;
    var updated = null;
    payments = payments.map(function(payment){
      if(payment.txId !== txId) return payment;
      before = copy(payment);
      payment.status = status;
      payment.note = note || payment.note || '';
      payment.statusNote = note || payment.statusNote || '';
      payment.updatedAt = now();
      updated = payment;
      return payment;
    });
    if(!updated) throw new Error('Payment '+txId+' was not found.');
    saveCollection('payments', payments);
    if(isPaidStatus(updated.status)) legacyMirror(updated);
    audit('Payment status updated', 'fee_payment', 'Payment '+txId+': '+(before.status || 'Unknown')+' → '+status, before, updated);
    return copy(updated);
  }

  // ── STUDENT WALLETS ───────────────────────────────────────
  // Wallet balances are deliberately never persisted. They are derived from
  // confirmed append-only credit and debit entries every time they are read.
  function isWalletConfirmed(status){
    return status === 'Confirmed';
  }

  function walletBalance(stuId){
    return money(readCollection('wallet').filter(function(entry){
      return String(entry.stuId || '') === String(stuId || '') && isWalletConfirmed(entry.status);
    }).reduce(function(total, entry){
      return total + (entry.type === 'debit' ? -money(entry.amount) : money(entry.amount));
    }, 0));
  }

  function nextWalletSequence(year, term){
    var highest = 0;
    var prefix = 'WAL/'+year+'/'+term+'/';
    readCollection('wallet').forEach(function(entry){
      var walId = entry.walId || '';
      if(walId.indexOf(prefix) === 0){
        var sequence = parseInt(walId.split('/').pop(), 10);
        if(sequence > highest) highest = sequence;
      }
    });
    return highest + 1;
  }

  function walletIdFor(options){
    var date = options.date || today();
    var year = recordYear(date);
    var term = termNumber(currentTerm(options.term));
    return options.walId || 'WAL/'+year+'/'+term+'/'+String(nextWalletSequence(year, term)).padStart(5,'0');
  }

  function walletEntry(options, type, feeTxId){
    options = options || {};
    var student = studentFor(options.stuId) || {};
    var term = currentTerm(options.term);
    var session = currentSession(options.session);
    var status = options.status || (type === 'credit' ? 'Pending' : 'Confirmed');
    return {
      id:options.id || id('wallet'),
      walId:walletIdFor(options),
      stuId:options.stuId || '',
      student:options.student || studentName(student),
      class:options.class || student.class || '--',
      type:type,
      amount:money(options.amount),
      reason:options.reason || (type === 'credit' ? 'Wallet funding' : 'School fee payment'),
      method:options.method || (type === 'credit' ? 'Cash' : 'Wallet'),
      status:status,
      ref:options.ref || '',
      by:options.by || userName(),
      date:options.date || today(),
      recordedAt:options.recordedAt || now(),
      note:options.note || '',
      feeTxId:feeTxId || options.feeTxId || '',
      term:term,
      session:session
    };
  }

  function walletCredit(options){
    options = options || {};
    var amount = money(options.amount);
    if(!options.stuId) throw new Error('A student is required to credit a wallet.');
    if(amount <= 0) throw new Error('Enter an amount greater than zero.');
    var entry = walletEntry(options, 'credit');
    if(entry.status !== 'Pending' && entry.status !== 'Confirmed' && entry.status !== 'Rejected'){
      throw new Error('Wallet credits must be Pending, Confirmed, or Rejected.');
    }
    var wallet = readCollection('wallet');
    var existing = wallet.some(function(row){ return row.walId === entry.walId; });
    if(existing) throw new Error('Wallet receipt '+entry.walId+' already exists.');
    wallet.push(entry);
    saveCollection('wallet', wallet);
    audit('Wallet credited', 'wallet_credit', 'Wallet '+entry.walId+': none → '+entry.status, null, entry);
    return copy(entry);
  }

  function walletDebit(options){
    options = options || {};
    var amount = money(options.amount);
    if(!options.stuId) throw new Error('A student is required to debit a wallet.');
    if(amount <= 0) throw new Error('Enter an amount greater than zero.');
    var available = walletBalance(options.stuId);
    if(amount > available){
      throw new Error('Insufficient wallet balance. Available: ₦'+available.toLocaleString());
    }
    // Generate the wallet receipt before the paired fee payment so both sides
    // can reference the same WAL identifier without storing a balance.
    var entry = walletEntry(options, 'debit');
    entry.status = 'Confirmed';
    var wallet = readCollection('wallet');
    var existing = wallet.some(function(row){ return row.walId === entry.walId; });
    if(existing) throw new Error('Wallet receipt '+entry.walId+' already exists.');
    var payment = pay({
      stuId:entry.stuId,
      student:entry.student,
      class:entry.class,
      reg:options.reg || '',
      amount:entry.amount,
      type:options.feeType || options.paymentType || 'School Fees',
      method:options.paymentMethod || 'Wallet',
      channel:options.channel || 'wallet',
      ref:entry.ref || entry.walId,
      status:options.paymentStatus || 'Paid',
      by:entry.by,
      source:'wallet',
      term:entry.term,
      session:entry.session,
      date:entry.date,
      note:entry.note,
      receiptNo:options.receiptNo || entry.walId
    });
    entry.feeTxId = payment.txId;
    wallet.push(entry);
    saveCollection('wallet', wallet);
    audit('Wallet debited', 'wallet_debit', 'Wallet '+entry.walId+': none → Confirmed', null, entry);
    var result = copy(entry);
    result.wallet = copy(entry);
    result.payment = copy(payment);
    result.balance = walletBalance(entry.stuId);
    return result;
  }

  function setWalletStatus(walId, status, note){
    if(status !== 'Confirmed' && status !== 'Rejected'){
      throw new Error('A pending wallet entry can only be Confirmed or Rejected.');
    }
    var wallet = readCollection('wallet');
    var before = null;
    var updated = null;
    wallet = wallet.map(function(entry){
      if(entry.walId !== walId) return entry;
      if(entry.status !== 'Pending') throw new Error('Only pending wallet entries can be updated.');
      before = copy(entry);
      entry.status = status;
      entry.note = note || entry.note || '';
      entry.statusNote = note || entry.statusNote || '';
      entry.updatedAt = now();
      updated = entry;
      return entry;
    });
    if(!updated) throw new Error('Wallet receipt '+walId+' was not found.');
    saveCollection('wallet', wallet);
    audit('Wallet status updated', updated.type === 'debit' ? 'wallet_debit' : 'wallet_credit', 'Wallet '+walId+': '+before.status+' → '+status, before, updated);
    return copy(updated);
  }

  function walletTotals(){
    var wallet = readCollection('wallet');
    var balances = {};
    var totalCredits = 0;
    var totalDebits = 0;
    wallet.forEach(function(entry){
      if(!isWalletConfirmed(entry.status)) return;
      var key = String(entry.stuId || '');
      if(!balances[key]) balances[key] = {stuId:entry.stuId || '', student:entry.student || '', class:entry.class || '', balance:0};
      if(entry.type === 'debit'){
        totalDebits += money(entry.amount);
        balances[key].balance -= money(entry.amount);
      }else{
        totalCredits += money(entry.amount);
        balances[key].balance += money(entry.amount);
      }
    });
    var wallets = Object.keys(balances).map(function(key){
      balances[key].balance = money(balances[key].balance);
      return balances[key];
    });
    return {
      totalBalance:money(totalCredits - totalDebits),
      activeWallets:wallets.filter(function(row){ return row.balance > 0; }).length,
      totalCredits:money(totalCredits),
      totalDebits:money(totalDebits),
      balances:wallets,
      entries:wallet
    };
  }

  function walletBalanceAfter(walId){
    var target = null;
    readCollection('wallet').some(function(entry){
      if(entry.walId === walId){ target = entry; return true; }
      return false;
    });
    if(!target) return 0;
    var rows = readCollection('wallet').map(function(entry, index){ return {entry:entry, index:index}; }).filter(function(row){
      return String(row.entry.stuId || '') === String(target.stuId || '');
    }).sort(function(a,b){
      var aa = String(a.entry.recordedAt || a.entry.date || '');
      var bb = String(b.entry.recordedAt || b.entry.date || '');
      if(aa === bb) return a.index - b.index;
      return aa.localeCompare(bb);
    });
    var balance = 0;
    for(var i=0;i<rows.length;i++){
      var entry = rows[i].entry;
      if(isWalletConfirmed(entry.status)) balance += entry.type === 'debit' ? -money(entry.amount) : money(entry.amount);
      if(entry.walId === walId) return money(balance);
    }
    return money(balance);
  }

  function walletEscape(value){
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function printWalletReceipt(walId){
    var entry = typeof walId === 'object' ? walId : null;
    if(!entry){
      readCollection('wallet').some(function(row){
        if(row.walId === walId){ entry = row; return true; }
        return false;
      });
    }
    if(!entry) throw new Error('Wallet receipt was not found.');
    var balanceAfter = walletBalanceAfter(entry.walId);
    var result = {entry:copy(entry), balanceAfter:balanceAfter};
    if(typeof window.open !== 'function') return result;
    var receipt = window.open('', '_blank', 'width=460,height=650');
    if(!receipt) return result;
    var direction = entry.type === 'debit' ? 'Debit' : 'Credit';
    var sign = entry.type === 'debit' ? '-' : '+';
    receipt.document.write('<!doctype html><html><head><title>Wallet Receipt</title><style>body{font-family:Arial,sans-serif;color:#172033;padding:24px;max-width:420px;margin:auto}h1{font-size:21px;margin:0 0 4px}.muted{color:#64748b;font-size:12px}.amount{font-size:28px;font-weight:800;margin:18px 0}.row{display:flex;justify-content:space-between;border-top:1px solid #e2e8f0;padding:10px 0;font-size:13px}.balance{background:#eff6ff;border-radius:10px;padding:13px;margin-top:15px}</style></head><body><h1>Student Wallet Receipt</h1><div class="muted">'+walletEscape(entry.walId)+'</div><div class="amount">'+sign+'₦'+money(entry.amount).toLocaleString()+'</div><div class="row"><span>Student</span><strong>'+walletEscape(entry.student)+'</strong></div><div class="row"><span>Type</span><strong>'+direction+'</strong></div><div class="row"><span>Reason</span><strong>'+walletEscape(entry.reason)+'</strong></div><div class="row"><span>Date</span><strong>'+walletEscape(entry.date)+'</strong></div><div class="row"><span>Status</span><strong>'+walletEscape(entry.status)+'</strong></div><div class="balance"><div class="muted">Balance after this transaction</div><strong>₦'+balanceAfter.toLocaleString()+'</strong></div><script>setTimeout(function(){window.print();},180);<\/script></body></html>');
    receipt.document.close();
    return result;
  }

  function migrateLegacy(force){
    // The flag records the first migration pass. A forced re-check is used
    // after an asynchronous Firebase fees sync and remains idempotent.
    if(!force && localStorage.getItem('rsms_finance_migrated') === 'true') return {migrated:false, count:0};
    var fees = readCollection('fees');
    var payments = readCollection('payments');
    var count = 0;
    fees.forEach(function(fee, index){
      var exists = payments.some(function(payment){
        return (fee.txId && payment.txId === fee.txId) ||
          (fee.receiptNo && payment.receiptNo === fee.receiptNo) ||
          (fee.id && payment.legacyFeeId === fee.id);
      });
      if(exists) return;
      var date = fee.date || today();
      var term = currentTerm(fee.term);
      var session = currentSession(fee.session);
      var legacyId = fee.id || ('legacy-'+index+'-'+String(fee.receiptNo || fee.ref || index).replace(/[^a-zA-Z0-9]/g,''));
      payments.push({
        id:'payment-'+legacyId,
        txId:fee.txId || ('LEGACY/'+legacyId),
        receiptNo:fee.receiptNo || ('LEGACY-RCP-'+(index+1)),
        stuId:fee.stuId || '',
        student:fee.student || fee.name || 'Unknown Student',
        class:fee.class || '--',
        reg:fee.reg || '--',
        amount:money(fee.amount),
        type:fee.type || 'School Fees',
        method:fee.method || 'Cash',
        channel:fee.channel || 'legacy',
        ref:fee.ref || '',
        status:'Paid',
        term:term,
        session:session,
        by:fee.by || 'Legacy import',
        date:date,
        recordedAt:fee.recordedAt || now(),
        source:'legacy',
        note:'Imported from legacy fees collection',
        legacyFeeId:fee.id || ''
      });
      count++;
    });
    if(count) {
      saveCollection('payments', payments);
      audit('Legacy finance migration', 'finance_migration', 'Imported '+count+' legacy fee record'+(count === 1 ? '' : 's')+' as Paid payments.', null, {count:count});
    }
    try { localStorage.setItem('rsms_finance_migrated', 'true'); } catch(e){}
    return {migrated:count > 0, count:count};
  }

  function onSync(handler){
    if(typeof handler === 'function') _syncHandlers.push(handler);
    return function(){
      var i = _syncHandlers.indexOf(handler);
      if(i > -1) _syncHandlers.splice(i, 1);
    };
  }

  function init(){
    if(_initialised) return;
    _initialised = true;
    migrateLegacy();
  }

  FINANCE_KEYS.forEach(function(key){
    (function(listenerKey){
      var handlerName = 'onFirebaseUpdate_'+listenerKey;
      var previous = window[handlerName];
      window[handlerName] = function(data){
        if(typeof previous === 'function'){
          try { previous(data); } catch(e){}
        }
        emitSync(listenerKey, asArray(data));
      };
    })(key);
  });

  // Legacy fees can arrive after the initial local migration when Firebase
  // warms the cache. Re-check safely; matching receipt/transaction IDs keep
  // the append-only payments ledger free of duplicates.
  (function(){
    var previousFees = window.onFirebaseUpdate_fees;
    window.onFirebaseUpdate_fees = function(data){
      if(typeof previousFees === 'function'){
        try { previousFees(data); } catch(e){}
      }
      setTimeout(function(){ migrateLegacy(true); }, 0);
      emitSync('fees', asArray(data));
    };
  })();

  window.FIND = {
    init:init,
    onSync:onSync,
    collection:readCollection,
    saveCollection:saveCollection,
    feeStructures:function(){ return readCollection('fee_structures'); },
    studentFees:function(){ return readCollection('student_fees'); },
    payments:function(){ return readCollection('payments'); },
    recurringPlans:function(){ return readCollection('recurring'); },
    expenses:function(){ return readCollection('expenses'); },
    wallet:function(){ return readCollection('wallet'); },
    walletBalance:walletBalance,
    walletCredit:walletCredit,
    walletDebit:walletDebit,
    setWalletStatus:setWalletStatus,
    walletTotals:walletTotals,
    walletBalanceAfter:walletBalanceAfter,
    printWalletReceipt:printWalletReceipt,
    students:students,
    studentFor:studentFor,
    school:school,
    context:function(){ return {term:currentTerm(), session:currentSession()}; },
    classTotal:classTotal,
    getFeeStructure:getFeeStructure,
    saveFeeStructure:saveFeeStructure,
    setFeeStructure:saveFeeStructure,
    getStudentFees:getStudentFees,
    saveStudentFees:saveStudentFees,
    setStudentFees:saveStudentFees,
    addStudentAdjustment:addStudentAdjustment,
    removeStudentAdjustment:removeStudentAdjustment,
    studentPayable:studentPayable,
    paidFor:paidFor,
    termStats:termStats,
    pay:pay,
    setPaymentStatus:setPaymentStatus,
    migrateLegacy:migrateLegacy,
    isPaidStatus:isPaidStatus,
    audit:audit
  };

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  }else{
    setTimeout(init, 0);
  }

})(window);
