def backfill(Conversation, Participant, ParticipantInterval):
    """Give every existing conversation two active participants + open intervals."""
    for convo in Conversation.objects.all().iterator():
        for user_id in (convo.user_a_id, convo.user_b_id):
            if user_id is None:
                continue
            participant, created = Participant.objects.get_or_create(
                conversation_id=convo.id, user_id=user_id,
                defaults={"status": "active"},
            )
            if created:
                ParticipantInterval.objects.create(
                    participant=participant, started_at=convo.created_at, ended_at=None,
                )
    Conversation.objects.filter(kind="").update(kind="direct")


# Callable used by the test with real model classes.
def _backfill(Conversation, Participant, ParticipantInterval):
    return backfill(Conversation, Participant, ParticipantInterval)
