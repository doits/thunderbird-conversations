const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource:///modules/XPCOMUtils.jsm"); // for generateQI

const gMessenger = Cc["@mozilla.org/messenger;1"]
                   .createInstance(Ci.nsIMessenger);
const gHeaderParser = Cc["@mozilla.org/messenger/headerparser;1"]
                      .getService(Ci.nsIMsgHeaderParser);

Cu.import("resource://conversations/AddressBookUtils.jsm");
Cu.import("resource://conversations/VariousUtils.jsm");
Cu.import("resource://conversations/MsgHdrUtils.jsm");
Cu.import("resource://conversations/send.js");
Cu.import("resource://conversations/log.js");

let Log = setupLogging("Conversations.Stub.Compose");
try {
  Cu.import("resource://people/modules/people.js");
} catch (e) {
  Log.debug("You don't have Contacts installed. Can't autocomplete.");
}

let gComposeParams = {
  msgHdr: null,
  identity: null,
  to: null,
  cc: null,
  bcc: null,
  subject: null,
};

// ----- Event listeners

// Called when we need to expand the textarea and start editing a new message
function onTextareaClicked(event) {
  // Do it just once
  if (!$(event.target).parent().hasClass('expand')) {
    $(event.target).parent().addClass('expand');
  }
  if (!gComposeParams.msgHdr) { // first time
    let messages = Conversations.currentConversation.messages;
    setupReplyForMsgHdr(messages[messages.length - 1].message._msgHdr);
    scrollNodeIntoView(document.querySelector(".quickReply"));
  }
}

function showCc(event) {
  $(".ccList, .editCcList").css("display", "");
  $(".showCc").hide();
}


function showBcc(event) {
  $(".bccList, .editBccList").css("display", "");
  $(".showBcc").hide();
}

function editFields(event) {
  $('.quickReplyRecipients').addClass('edit');
}

function onDiscard(event) {
  $(".quickReply").removeClass('expand');
  $("textarea").val("");
}

function onSend(event) {
  let textarea = document.getElementsByTagName("textarea")[0];
  sendMessage({
      msgHdr: gComposeParams.msgHdr,
      identity: gComposeParams.identity,
      to: $("#to").val(),
      cc: $("#cc").val(),
      bcc: $("#bcc").val(),
      subject: gComposeParams.subject,
    }, {
      compType: Ci.nsIMsgCompType.ReplyAll,
      deliverType: Ci.nsIMsgCompDeliverMode.Now,
    }, textarea, {
      progressListener: progressListener,
      sendListener: sendListener,
    }
  );
}

// ----- Helpers

// Just get the email and/or name from a MIME-style "John Doe <john@blah.com>"
//  line.
function parse(aMimeLine) {
  let emails = {};
  let fullNames = {};
  let names = {};
  let numAddresses = gHeaderParser.parseHeadersWithArray(aMimeLine, emails, names, fullNames);
  return [names.value, emails.value];
}

// ----- Main logic

// The logic that decides who to compose, from which address, etc. etc.
function setupReplyForMsgHdr(aMsgHdr) {
  // Standard procedure for finding which identity to send with, as per
  // http://mxr.mozilla.org/comm-central/source/mail/base/content/mailCommands.js#210
  // XXX something's wrong but I don't know what
  let mainWindow = getMail3Pane();
  let identityForFolder = function (folder) {
    let identity = folder.customIdentity;
    let server = folder.server;
    if (!identity)
      identity = mainWindow.getIdentityForServer(folder.server);
    return identity;
  }
  let identity = ((identityForFolder(mainWindow.GetFirstSelectedMsgFolder())
      || identityForFolder(aMsgHdr.folder))
    || gIdentities.default);
  // Set the global parameters
  gComposeParams.identity = identity;
  gComposeParams.msgHdr = aMsgHdr;
  gComposeParams.subject = "Re: "+aMsgHdr.mime2DecodedSubject;

  // Do the whole shebang to find out who to send to...
  let [author, authorEmailAddress] = parse(aMsgHdr.mime2DecodedAuthor);
  let [recipients, recipientsEmailAddresses] = parse(aMsgHdr.mime2DecodedRecipients);
  let [ccList, ccListEmailAddresses] = parse(aMsgHdr.ccList);
  let [bccList, bccListEmailAddresses] = parse(aMsgHdr.bccList);

  let isReplyToOwnMsg = false;
  for each (let [i, identity] in Iterator(gIdentities)) {
    let email = identity.email;
    if (email == authorEmailAddress)
      isReplyToOwnMsg = true;
    if (recipientsEmailAddresses.filter(function (x) x == email).length)
      isReplyToOwnMsg = false;
    if (ccListEmailAddresses.filter(function (x) x == email).length)
      isReplyToOwnMsg = false;
  }

  // Actually we are implementing the "Reply all" logic... that's better, no one
  //  wants to really use reply anyway ;-)
  if (isReplyToOwnMsg) {
    Log.debug("Replying to our own message...");
    gComposeParams.to = [asToken(null, r, recipientsEmailAddresses[i], null)
      for each ([i, r] in Iterator(recipients))];
  } else {
    gComposeParams.to = [asToken(null, author, authorEmailAddress, null)];
  }
  gComposeParams.cc = [asToken(null, cc, ccListEmailAddresses[i], null)
    for each ([i, cc] in Iterator(ccList))
    if (ccListEmailAddresses[i] != identity.email)];
  if (!isReplyToOwnMsg)
    gComposeParams.cc = gComposeParams.cc.concat
      ([asToken(null, r, recipientsEmailAddresses[i], null)
        for each ([i, r] in Iterator(recipients))
        if (recipientsEmailAddresses[i] != identity.email)]);
  gComposeParams.bcc = [asToken(null, bcc, bccListEmailAddresses[i], null)
    for each ([i, bcc] in Iterator(bccList))];

  // And update our nice composition UI
  updateUI();
}

// When all the composition parameters have been set, update the UI with them
// (e.g. recipients, sender, etc.)
function updateUI() {
  let i = gComposeParams.identity;
  $(".senderName").text(i.fullName + " <"+i.email+">");
  setupAutocomplete();
}

// ----- Autocomplete stuff

// Wrap the given parameters in an object that's compatible with the
//  facebook-style autocomplete.
function asToken(thumb, name, email, guid) {
  let hasName = name && (String.trim(name).length > 0);
  let data = hasName ? name + " <" + email + ">" : email;
  let thumbStr = thumb ? "<img class='autocomplete-thumb' src=\""+thumb+"\" /> " : "";
  let nameStr = hasName ? name + " &lt;" + email + "&gt;" : email;
  let listItem = thumbStr + nameStr;
  let id = guid;
  let displayName = hasName ? name : email;
  return { name: displayName, listItem: listItem, data: data, id: guid }
}

function peopleAutocomplete(query, callback) {
  if (!("People" in window)) {
    callback([asToken(null, null, query, query)]);
  } else {
    let results = [];
    let dupCheck = {};
    let add = function(person) {
      let photos = person.getProperty("photos");
      let thumb;
      for each (let photo in photos) {
        if (photo.type == "thumbnail") {
          thumb = photo.value;
          break;
        }
      }

      let suggestions = person.getProperty("emails");
      for each (let suggestion in suggestions)
      {
        if (suggestion.value in dupCheck)
          continue;
        dupCheck[suggestion.value] = null;
        results.push(asToken(thumb, person.displayName, suggestion.value, person.guid));
      }
    };
    try {
      // Contacts doesn't seem to allow a OR, so run two queries... (longer)
      People.find({ displayName: query }).forEach(add);
      People.find({ emails: query }).forEach(add);
    } catch(e) {
      Log.error(e);
      dumpCallStack(e);
    }
    if (!results.length)
      results.push(asToken(null, null, query, query));
    callback(results);
  }
}

let autoCompleteClasses = {
  tokenList: "token-input-list-facebook",
  token: "token-input-token-facebook",
  tokenDelete: "token-input-delete-token-facebook",
  selectedToken: "token-input-selected-token-facebook",
  highlightedToken: "token-input-highlighted-token-facebook",
  dropdown: "token-input-dropdown-facebook",
  dropdownItem: "token-input-dropdown-item-facebook",
  dropdownItem2: "token-input-dropdown-item2-facebook",
  selectedDropdownItem: "token-input-selected-dropdown-item-facebook",
  inputToken: "token-input-input-token-facebook"
}

function setupAutocomplete() {
  // XXX this function can't be called twice, make sure we thrash the previous
  // #to, #cc, etc.
  let fill = function (aInput, aList, aData) {
    $(aInput).tokenInput(peopleAutocomplete, {
      classes: autoCompleteClasses,
      prePopulate: aData,
    });
    $(aList+" li:not(.add-more)").remove();
    for each (let [i, { name, data: email }] in Iterator(aData)) {
      if (!email)
        continue;
      let sep;
      if (aData.length <= 1)
        sep = "";
      else if (i == aData.length - 2)
        sep = "&nbsp;and&nbsp;";
      else if (i == aData.length - 1)
        sep = "";
      else
        sep = ",&nbsp;";
      $(aList+" .add-more").before($("<li title=\""+email+"\">"+name+sep+"</li>"));
    }
  };
  fill("#to", ".toList", gComposeParams.to);
  fill("#cc", ".ccList", gComposeParams.cc);
  fill("#bcc", ".bccList", gComposeParams.bcc);

  if (gComposeParams.cc.length)
    showCc();
  if (gComposeParams.bcc.length)
    showBcc();
}

// ----- Listeners.
//
// These are notified about the outcome of the send process and take the right
//  action accordingly (close window on success, etc. etc.)

function pValue (v) {
  $(".statusPercentage")
    .show()
    .text(v+"%")
}

function pUndetermined () {
  $(".statusPercentage")
    .hide()
}

function pText (t) {
  $(".statusMessage").text(t);
}

// all progress notifications are done through the nsIWebProgressListener implementation...
let progressListener = {
  onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
    Log.debug("onStateChange", aWebProgress, aRequest, aStateFlags, aStatus);
    if (aStateFlags & Ci.nsIWebProgressListener.STATE_START) {
      pUndetermined();
      $(".quickReplyHeader").show();
    }

    if (aStateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
      pValue(0);
      pText('');
      $(".quickReplyHeader").hide();
      $(".quickReply").removeClass('expand');
      $("textarea").val("");
    }
  },

  onProgressChange: function(aWebProgress, aRequest, aCurSelfProgress, aMaxSelfProgress, aCurTotalProgress, aMaxTotalProgress) {
    Log.debug("onProgressChange", aWebProgress, aRequest, aCurSelfProgress, aMaxSelfProgress, aCurTotalProgress, aMaxTotalProgress);
    // Calculate percentage.
    var percent;
    if (aMaxTotalProgress > 0) {
      percent = Math.round( (aCurTotalProgress*100)/aMaxTotalProgress );
      if (percent > 100)
        percent = 100;

      // Advance progress meter.
      pValue(percent);
    } else {
      // Progress meter should be barber-pole in this case.
      pUndetermined();
    }
  },

  onLocationChange: function(aWebProgress, aRequest, aLocation) {
    // we can ignore this notification
  },

  onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) {
    pText(aMessage);
  },

  onSecurityChange: function(aWebProgress, aRequest, state) {
    // we can ignore this notification
  },

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIWebProgressListener,
    Ci.nsISupports
  ]),
};

let sendListener = {
  /**
   * Notify the observer that the message has started to be delivered. This method is
   * called only once, at the beginning of a message send operation.
   *
   * @return The return value is currently ignored.  In the future it may be
   * used to cancel the URL load..
   */
  onStartSending: function (aMsgID, aMsgSize) {
    pText("Sending message...");
    Log.debug("onStartSending", aMsgID, aMsgSize);
  },

  /**
   * Notify the observer that progress as occurred for the message send
   */
  onProgress: function (aMsgID, aProgress, aProgressMax) {
    Log.debug("onProgress", aMsgID, aProgress, aProgressMax);
  },

  /**
   * Notify the observer with a status message for the message send
   */
  onStatus: function (aMsgID, aMsg) {
    Log.debug("onStatus", aMsgID, aMsg);
  },

  /**
   * Notify the observer that the message has been sent.  This method is 
   * called once when the networking library has finished processing the 
   * message.
   * 
   * This method is called regardless of whether the the operation was successful.
   * aMsgID   The message id for the mail message
   * status   Status code for the message send.
   * msg      A text string describing the error.
   * returnFileSpec The returned file spec for save to file operations.
   */
  onStopSending: function (aMsgID, aStatus, aMsg, aReturnFile) {
    // if (aExitCode == NS_ERROR_SMTP_SEND_FAILED_UNKNOWN_SERVER ||
    //     aExitCode == NS_ERROR_SMTP_SEND_FAILED_UNKNOWN_REASON ||
    //     aExitCode == NS_ERROR_SMTP_SEND_FAILED_REFUSED ||
    //     aExitCode == NS_ERROR_SMTP_SEND_FAILED_INTERRUPTED ||
    //     aExitCode == NS_ERROR_SMTP_SEND_FAILED_TIMEOUT ||
    //     aExitCode == NS_ERROR_SMTP_PASSWORD_UNDEFINED ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_FAILURE ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_GSSAPI ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_MECH_NOT_SUPPORTED ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_NOT_SUPPORTED ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_CHANGE_ENCRYPT_TO_PLAIN_NO_SSL ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_CHANGE_ENCRYPT_TO_PLAIN_SSL ||
    //     aExitCode == NS_ERROR_SMTP_AUTH_CHANGE_PLAIN_TO_ENCRYPT ||
    //     aExitCode == NS_ERROR_STARTTLS_FAILED_EHLO_STARTTLS)
    //
    // Moar in mailnews/compose/src/nsComposeStrings.h
    Log.debug("onStopSending", aMsgID, aStatus, aMsg, aReturnFile);
    // This function is called only when the actual send has been performed,
    //  i.e. is not called when saving a draft (although msgCompose.SendMsg is
    //  called...)
    if (NS_SUCCEEDED(aStatus)) {
      //if (gOldDraftToDelete)
      //  msgHdrsDelete([gOldDraftToDelete]);
      pText("Message "+aMsgID+" sent successfully"); 
    } else {
      Log.debug("NS_FAILED onStopSending");
    }
  },

  /**
   * Notify the observer with the folder uri before the draft is copied.
   */
  onGetDraftFolderURI: function (aFolderURI) {
    Log.debug("onGetDraftFolderURI", aFolderURI);
  },

  /**
   * Notify the observer when the user aborts the send without actually doing the send
   * eg : by closing the compose window without Send.
   */
  onSendNotPerformed: function (aMsgID, aStatus) {
    Log.debug("onSendNotPerformed", aMsgID, aStatus);
  },

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIMsgSendListener,
    Ci.nsISupports
  ]),
}

let copyListener = {
  onStopCopy: function (aStatus) {
    Log.debug("onStopCopy", aStatus);
    if (NS_SUCCEEDED(aStatus)) {
      //if (gOldDraftToDelete)
      //  msgHdrsDelete(gOldDraftToDelete);
    }
  },

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIMsgCopyServiceListener,
    Ci.nsISupports
  ]),
}
