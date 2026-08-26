# Following a connection to be notified when they post (issue #382).
#
# **Creates no rows, deliberately.** Following is opt-in and off by default:
# there is no backfill seeding subscriptions for existing connections, and no
# data migration anywhere that writes one. The absence of a row *is* the off
# state, so this migration ships the feature silent — every subscription that
# ever exists was created by a person pressing Follow. A test asserts it
# (``FollowOptInTests``), because a well-meaning "helpful" backfill later is
# exactly how a promise like this gets broken.
#
# The two AlterFields are the ``new_post`` kind joining the choices enum; they
# rewrite no data (``choices`` is validation metadata, not a column change).

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0033_previews_on_by_default'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AlterField(
            model_name='notification',
            name='kind',
            field=models.CharField(choices=[('post_reply', 'Reply to your post'), ('comment_reply', 'Reply to your comment'), ('reaction', 'Reaction to your content'), ('connection_request', 'Connection request'), ('connection_accepted', 'Connection accepted'), ('group_invite', 'Group invitation'), ('event_created', 'New group event'), ('poll_opened', 'Poll opened on an event'), ('event_scheduled', 'Event date set'), ('event_updated', 'Event changed'), ('event_cancelled', 'Event cancelled'), ('event_comment', 'Comment on your event'), ('event_photos', 'Photos added to an event'), ('mention', 'You were mentioned in a chat'), ('new_post', 'New post from someone you follow')], max_length=32),
        ),
        migrations.AlterField(
            model_name='notificationpreference',
            name='kind',
            field=models.CharField(choices=[('post_reply', 'Reply to your post'), ('comment_reply', 'Reply to your comment'), ('reaction', 'Reaction to your content'), ('connection_request', 'Connection request'), ('connection_accepted', 'Connection accepted'), ('group_invite', 'Group invitation'), ('event_created', 'New group event'), ('poll_opened', 'Poll opened on an event'), ('event_scheduled', 'Event date set'), ('event_updated', 'Event changed'), ('event_cancelled', 'Event cancelled'), ('event_comment', 'Comment on your event'), ('event_photos', 'Photos added to an event'), ('mention', 'You were mentioned in a chat'), ('new_post', 'New post from someone you follow')], max_length=32),
        ),
        migrations.CreateModel(
            name='PostNotificationSubscription',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('followee', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='post_subscribers', to=settings.AUTH_USER_MODEL)),
                ('follower', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='post_subscriptions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('follower', 'followee'), name='unique_post_subscription'), models.CheckConstraint(condition=models.Q(('follower', models.F('followee')), _negated=True), name='no_self_post_subscription')],
            },
        ),
    ]
